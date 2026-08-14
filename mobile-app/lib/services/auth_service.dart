// lib/services/auth_service.dart
// CORRIGÉ — loginAndWaitRole attend la fin du chargement du rôle

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

class AuthService extends ChangeNotifier {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  User? get currentUser => _auth.currentUser;

  String _role = '';
  String _nom = '';
  String _uid = '';
  bool _isLoading = true;
  bool _privilegie = false;

  String get role => _role;
  String get nom => _nom;
  String get uid => _uid;
  bool get isLoading => _isLoading;

  bool get isAdmin => _role == 'admin';
  bool get isConducteur => _role == 'conducteur';

  /// Conducteur "privilégié" : peut choisir lui-même son bus et son circuit
  /// après connexion (au lieu d'attendre une affectation par l'admin).
  bool get isPrivilegie => _privilegie;

  String _conducteurDocId = '';
  /// ID réel du document Firestore `conducteurs/{id}` (peut différer de l'UID
  /// si le conducteur a été retrouvé via le champ 'login').
  String get conducteurDocId => _conducteurDocId;

  StreamSubscription<User?>? _authSub;

  AuthService() {
    _authSub = _auth.authStateChanges().listen(_onAuthChanged);
  }

  Future<void> _onAuthChanged(User? user) async {
    if (user == null) {
      _uid = '';
      _role = '';
      _nom = '';
      _privilegie = false;
      _conducteurDocId = '';
      _isLoading = false;
      notifyListeners();
    } else {
      _uid = user.uid;
      _isLoading = true;
      notifyListeners();
      await _loadUserRole(_uid);
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> _loadUserRole(String uid) async {
    try {
      // Chercher d'abord dans admins
      final adminDoc = await _db.collection('admins').doc(uid).get();
      if (adminDoc.exists) {
        _role = 'admin';
        _nom = adminDoc.data()?['nom'] ?? 'Administrateur';
        return;
      }

      // Chercher dans conducteurs avec l'UID comme ID du document
      final condDoc = await _db.collection('conducteurs').doc(uid).get();
      if (condDoc.exists) {
        _role = 'conducteur';
        _nom = condDoc.data()?['nom'] ?? 'Conducteur';
        _privilegie = condDoc.data()?['privilegie'] == true;
        _conducteurDocId = condDoc.id;
        return;
      }

      // Si pas trouvé avec l'UID, chercher par le champ 'login'
      final condQuery = await _db
          .collection('conducteurs')
          .where('login', isEqualTo: currentUser?.email)
          .limit(1)
          .get();

      if (condQuery.docs.isNotEmpty) {
        _role = 'conducteur';
        _nom = condQuery.docs.first.data()['nom'] ?? 'Conducteur';
        _privilegie = condQuery.docs.first.data()['privilegie'] == true;
        _conducteurDocId = condQuery.docs.first.id;
        return;
      }

      _role = 'inconnu';
      _nom = '';
      _privilegie = false;
      _conducteurDocId = '';
    } catch (e) {
      print('Erreur chargement rôle: $e');
      _role = 'inconnu';
      _nom = '';
      _privilegie = false;
      _conducteurDocId = '';
    }
  }

  /// Connecte l'utilisateur ET attend que son rôle soit chargé depuis Firestore.
  /// Retourne null si succès, ou un message d'erreur.
  Future<String?> loginAndWaitRole(String email, String password) async {
    try {
      // 1. Connexion Firebase Auth
      await _auth.signInWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );

      // 2. Attendre que _isLoading repasse à false
      // (déclenché par _onAuthChanged → _loadUserRole → notifyListeners)
      if (_isLoading) {
        final completer = Completer<void>();
        void listener() {
          if (!_isLoading) {
            removeListener(listener);
            completer.complete();
          }
        }
        addListener(listener);
        await completer.future.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            removeListener(listener);
          },
        );
      }

      return null;
    } on FirebaseAuthException catch (e) {
      switch (e.code) {
        case 'user-not-found':
          return 'Utilisateur introuvable';
        case 'wrong-password':
        case 'invalid-credential':
          return 'Email ou mot de passe incorrect';
        case 'invalid-email':
          return 'Adresse email invalide';
        case 'too-many-requests':
          return 'Trop de tentatives. Réessayez plus tard';
        default:
          return 'Erreur : ${e.message}';
      }
    } catch (e) {
      return 'Erreur inattendue : $e';
    }
  }

  Future<void> logout() async {
    await _auth.signOut();
  }

  /// Envoie un e-mail de réinitialisation du mot de passe, mais uniquement
  /// si l'adresse correspond à un conducteur enregistré (collection
  /// Firestore `conducteurs`, champ `login`). Les comptes admin ne peuvent
  /// pas réinitialiser leur mot de passe par e-mail depuis cette app : ils
  /// doivent le changer depuis le dashboard web React une fois connectés.
  /// Retourne null si succès, sinon un message d'erreur lisible.
  Future<String?> sendPasswordResetEmail(String email) async {
    final trimmedEmail = email.trim();
    try {
      final condQuery = await _db
          .collection('conducteurs')
          .where('login', isEqualTo: trimmedEmail)
          .limit(1)
          .get();

      if (condQuery.docs.isEmpty) {
        return "Aucun conducteur enregistré avec cet e-mail. "
            "La réinitialisation par e-mail n'est disponible que pour les "
            "conducteurs enregistrés.";
      }

      await _auth.sendPasswordResetEmail(email: trimmedEmail);
      return null;
    } on FirebaseAuthException catch (e) {
      switch (e.code) {
        case 'user-not-found':
          return 'Aucun compte associé à cet e-mail';
        case 'invalid-email':
          return 'Adresse e-mail invalide';
        case 'too-many-requests':
          return 'Trop de tentatives. Réessayez plus tard';
        default:
          return 'Erreur : ${e.message}';
      }
    } catch (e) {
      return 'Erreur inattendue : $e';
    }
  }

  /// Change le mot de passe de l'utilisateur connecté. Nécessite une
  /// reconnexion récente : on ré-authentifie avec le mot de passe actuel
  /// avant d'appliquer le nouveau. Retourne null si succès, sinon un
  /// message d'erreur lisible.
  Future<String?> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    final user = _auth.currentUser;
    if (user == null || user.email == null) {
      return 'Aucun utilisateur authentifié trouvé.';
    }
    try {
      final credential = EmailAuthProvider.credential(
        email: user.email!,
        password: currentPassword,
      );
      await user.reauthenticateWithCredential(credential);
      await user.updatePassword(newPassword);
      return null;
    } on FirebaseAuthException catch (e) {
      switch (e.code) {
        case 'wrong-password':
        case 'invalid-credential':
          return 'Mot de passe actuel incorrect';
        case 'weak-password':
          return 'Le nouveau mot de passe est trop faible (6 caractères min.)';
        case 'too-many-requests':
          return 'Trop de tentatives. Réessayez plus tard';
        default:
          return 'Erreur : ${e.message}';
      }
    } catch (e) {
      return 'Erreur inattendue : $e';
    }
  }

  @override
  void dispose() {
    _authSub?.cancel();
    super.dispose();
  }
}