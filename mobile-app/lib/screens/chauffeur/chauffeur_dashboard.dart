// lib/screens/chauffeur/chauffeur_dashboard.dart
import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../services/auth_service.dart';
import 'liste_salaries_screen.dart';

// ── RTDB (Europe) ─────────────────────────────────────────────────────────────
final _rtdb = FirebaseDatabase.instanceFor(
  app: FirebaseDatabase.instance.app,
  databaseURL: 'https://wicmic-71b1e-default-rtdb.europe-west1.firebasedatabase.app',
);

String get _todayKey {
  final n = DateTime.now();
  return '${n.year}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

// ── Helpers de lecture RTDB (identiques à liste_salaries_screen.dart) ──
// 'attendance' peut être imbriqué arbitrairement ; on aplatit récursivement.
bool _isLeafRecord(dynamic v) {
  if (v is! Map) return false;
  return v['matricule'] != null ||
      v['employee'] != null ||
      v['timestamp'] != null ||
      v['created_at'] != null ||
      (v['date'] != null && (v['time'] != null || v['bus_id'] != null));
}

List<Map<String, dynamic>> _flattenRtdbRecords(dynamic data) {
  final results = <Map<String, dynamic>>[];
  void walk(dynamic node) {
    if (node is! Map) return;
    if (_isLeafRecord(node)) {
      results.add(Map<String, dynamic>.from(node));
      return;
    }
    node.forEach((key, value) {
      if (value is Map) walk(value);
    });
  }
  walk(data);
  return results;
}

/// Variante qui conserve le chemin RTDB complet de chaque enregistrement
/// (ex: "22/-OsYP3uTpCEtSSw60n_q"), pour pouvoir écrire dessus ensuite
/// (ex: marquer une alerte comme acquittée).
List<MapEntry<String, Map<String, dynamic>>> _flattenRtdbRecordsWithPath(
    dynamic data) {
  final results = <MapEntry<String, Map<String, dynamic>>>[];
  void walk(dynamic node, List<String> pathKeys) {
    if (node is! Map) return;
    if (_isLeafRecord(node)) {
      results.add(MapEntry(pathKeys.join('/'), Map<String, dynamic>.from(node)));
      return;
    }
    node.forEach((key, value) {
      if (value is Map) walk(value, [...pathKeys, key.toString()]);
    });
  }
  walk(data, []);
  return results;
}

String _dateKeyOf(Map<String, dynamic> rec) {
  if (rec['date'] is String) return rec['date'] as String;
  final raw = rec['timestamp'] ?? rec['created_at'];
  if (raw is String) {
    try {
      final d = DateTime.parse(raw);
      return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
    } catch (_) {}
  }
  return '';
}

/// On ne garde que deux méthodes de pointage : reconnaissance faciale
/// (automatique) ou manuel. Les anciennes valeurs (badge_nfc, biométrique...)
/// sont regroupées avec 'manuel'.
String _normMethode(String? raw) {
  const facial = {'face', 'reconnaissance_faciale', 'facial', 'reconnaissance'};
  if (raw != null && facial.contains(raw)) return 'reconnaissance_faciale';
  return 'manuel';
}

/// Fusionne 'attendance' (auto) + 'manual_checkins' du jour pour un bus donné,
/// indexés par matricule.
Map<String, Map<String, dynamic>> _buildPresenceMapByMatricule({
  required dynamic attendanceRaw,
  required dynamic manualCheckinsRaw,
  required String busId,
  required String todayKey,
  bool attendanceAlreadyDateScoped = true,
}) {
  final map = <String, Map<String, dynamic>>{};
  // 'attendance' est lu depuis attendance/{immatriculation}/{date}/... : le
  // chemin scope déjà au bon bus. Il n'y a donc pas de champ 'bus_id' à
  // vérifier ici (contrairement à 'alerts' et 'manual_checkins').
  if (attendanceRaw != null) {
    for (final rec in _flattenRtdbRecords(attendanceRaw)) {
      if (!attendanceAlreadyDateScoped && _dateKeyOf(rec) != todayKey) continue;
      final mat = (rec['matricule'] ?? rec['employee'])?.toString();
      if (mat == null || mat.isEmpty) continue;
      map[mat] = {...rec, 'identification': rec['identification'] ?? 'face'};
    }
  }
  if (manualCheckinsRaw is Map) {
    manualCheckinsRaw.forEach((salarieId, value) {
      if (value is! Map) return;
      final rec = Map<String, dynamic>.from(value);
      if ((rec['bus_id'] as String?) != busId) return;
      final mat = (rec['matricule'] ?? salarieId).toString();
      map[mat] = {...rec, 'salarie_id': salarieId};
    });
  }
  return map;
}

// Clés de la semaine courante (lundi → aujourd'hui)
List<String> get _weekKeys {
  final now = DateTime.now();
  final monday = now.subtract(Duration(days: now.weekday - 1));
  return List.generate(now.weekday, (i) {
    final d = monday.add(Duration(days: i));
    return '${d.year}-${d.month.toString().padLeft(2,'0')}-${d.day.toString().padLeft(2,'0')}';
  });
}

// ── Haversine distance (mètres) ───────────────────────────────────────────────
double _haversine(double lat1, double lon1, double lat2, double lon2) {
  const R = 6371000.0;
  final dLat = (lat2 - lat1) * math.pi / 180;
  final dLon = (lon2 - lon1) * math.pi / 180;
  final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) *
      math.sin(dLon / 2) * math.sin(dLon / 2);
  return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
}

// ── Palette ────────────────────────────────────────────────────────────────────
const _kBlue     = Color(0xFF0D47A1);
const _kBlueMid  = Color(0xFF1565C0);
const _kBlueLite = Color(0xFF1976D2);
const _kBg       = Color(0xFFF0F4F8);

// ═════════════════════════════════════════════════════════════════════════════
//  Widget racine
// ═════════════════════════════════════════════════════════════════════════════
class ChauffeurDashboard extends StatefulWidget {
  const ChauffeurDashboard({super.key});
  @override
  State<ChauffeurDashboard> createState() => _ChauffeurDashboardState();
}

class _ChauffeurDashboardState extends State<ChauffeurDashboard> {
  int _selectedIndex = 0;
  Position? _position;
  bool _gpsLoading = false;
  String _gpsError = '';
  StreamSubscription<Position>? _posStream;

  // Bus ID du conducteur connecté (résolu depuis Firestore)
  String _busId = '';
  // Immatriculation du bus (utilisée comme clé dans RTDB attendance/{immatriculation}/...)
  String _busImmatriculation = '';
  StreamSubscription<DocumentSnapshot>? _busSub;

  // Alerte visage inconnu
  bool _alerteVisageInconnu = false;
  String _nomAlerteVisage = '';
  StreamSubscription<DatabaseEvent>? _alerteSub;
  StreamSubscription<DocumentSnapshot>? _condSub;

  @override
  void initState() {
    super.initState();
    // Attendre que AuthService soit prêt puis charger le busId
    // (_startAlerteListener sera relancé automatiquement une fois le bus connu)
    WidgetsBinding.instance.addPostFrameCallback((_) => _listenConducteur());
  }

  @override
  void dispose() {
    _posStream?.cancel();
    _alerteSub?.cancel();
    _condSub?.cancel();
    _busSub?.cancel();
    super.dispose();
  }

  // ── Écouter le doc conducteur pour récupérer bus_id en temps réel ─────────
  void _listenConducteur() {
    final uid = context.read<AuthService>().uid;
    if (uid.isEmpty) return;
    _condSub = FirebaseFirestore.instance
        .collection('conducteurs')
        .doc(uid)
        .snapshots()
        .listen((snap) {
      final d = snap.data() ?? {};
      final newBusId = d['bus_id'] as String? ?? '';
      if (newBusId != _busId) {
        setState(() => _busId = newBusId);
        // Relancer le GPS stream avec le nouveau busId
        if (newBusId.isNotEmpty && _posStream == null) _startGpsStream();

        // Résoudre l'immatriculation (clé utilisée dans RTDB attendance/{imm}/...)
        // et relancer l'écoute des alertes filtrée sur ce bus.
        _busSub?.cancel();
        if (newBusId.isNotEmpty) {
          _busSub = FirebaseFirestore.instance
              .collection('buses')
              .doc(newBusId)
              .snapshots()
              .listen((busSnap) {
            final imm = busSnap.data()?['immatriculation'] as String? ?? '';
            if (imm != _busImmatriculation) {
              setState(() => _busImmatriculation = imm);
            }
          });
        } else {
          setState(() => _busImmatriculation = '');
        }
        _startAlerteListener();
      }
    });
  }

  // ── GPS stream continu → Firestore buses/{busId} ─────────────────────────
  Future<void> _startGpsStream() async {
    setState(() { _gpsLoading = true; _gpsError = ''; });
    try {
      bool ok = await Geolocator.isLocationServiceEnabled();
      if (!ok) { setState(() { _gpsError = 'GPS désactivé'; _gpsLoading = false; }); return; }
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        setState(() { _gpsError = 'Permission refusée'; _gpsLoading = false; }); return;
      }
      _posStream?.cancel();
      _posStream = Geolocator.getPositionStream(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 20),
      ).listen((pos) async {
        setState(() { _position = pos; _gpsLoading = false; });
        final uid = context.read<AuthService>().uid;
        final busId = _busId;
        final db = FirebaseFirestore.instance;

        // 1. Mettre à jour last_gps sur le bus (admin le voit en temps réel)
        if (busId.isNotEmpty) {
          await db.collection('buses').doc(busId).update({
            'last_gps': {
              'lat': pos.latitude,
              'lng': pos.longitude,
              'speed_kmh': (pos.speed * 3.6).clamp(0, 300),
              'accuracy': pos.accuracy,
              'timestamp': FieldValue.serverTimestamp(),
            },
          });

          // 2. Enregistrer le point GPS dans la sous-collection de trajet du jour
          //    pour calculer la distance parcourue
          await db
              .collection('buses')
              .doc(busId)
              .collection('gps_points')
              .doc(_todayKey)
              .collection('points')
              .add({
            'lat': pos.latitude,
            'lng': pos.longitude,
            'ts': FieldValue.serverTimestamp(),
            'conducteur_uid': uid,
          });
        }

        // 3. Aussi mettre à jour last_gps sur le conducteur (rétrocompat)
        if (uid.isNotEmpty) {
          await db.collection('conducteurs').doc(uid).update({
            'last_gps_lat': pos.latitude,
            'last_gps_lng': pos.longitude,
            'last_gps_ts': FieldValue.serverTimestamp(),
          });
        }
      }, onError: (_) {
        setState(() { _gpsError = 'Erreur GPS'; _gpsLoading = false; });
      });
    } catch (_) {
      setState(() { _gpsError = 'Erreur GPS'; _gpsLoading = false; });
    }
  }

  // ── Alertes (RTDB 'alerts', filtrées sur ce bus) ──────────────────────────
  // Chemin réel : alerts/<bucket>/<pushId>/{alert_type, bus_id, code_trajet,
  // timestamp, matricule?, temperature?, nom?}. 'bus_id' est au format
  // Firestore ("BUS_2603TU140"), donc on filtre directement par _busId.
  String? _alertePath; // chemin RTDB complet de l'alerte affichée, pour l'acquittement
  bool _alerteEmployeIdentifie = false; // true si l'alerte porte un nom (employé reconnu)
  String? _matriculeAlerteVisage; // matricule de l'employé identifié, pour afficher sa photo enrôlée

  void _startAlerteListener() {
    _alerteSub?.cancel();
    if (_busId.isEmpty) {
      setState(() { _alerteVisageInconnu = false; _nomAlerteVisage = ''; _alertePath = null; _alerteEmployeIdentifie = false; _matriculeAlerteVisage = null; });
      return;
    }
    _alerteSub = _rtdb.ref('alerts').onValue.listen((event) {
      if (!mounted) return;
      final data = event.snapshot.value;
      final entries = _flattenRtdbRecordsWithPath(data)
          .where((e) =>
              e.value['bus_id'] == _busId &&
              e.value['acknowledged'] != true &&
              _dateKeyOf(e.value) == _todayKey)
          .toList();

      if (entries.isNotEmpty) {
        // La plus récente en dernier (ordre d'insertion RTDB approx. chronologique)
        final derniere = entries.last;
        final type = derniere.value['alert_type'] as String? ?? 'alerte';
        // Un employé est "identifié" si l'alerte porte son nom (ex : reconnu
        // mais en fièvre). Dans ce cas on affiche son nom, pas un message
        // générique "visage non reconnu".
        final nomBrut = (derniere.value['nom'] as String?)?.trim();
        final identifie = nomBrut != null && nomBrut.isNotEmpty;
        final label = type == 'fever'
            ? 'Alerte température (${derniere.value['temperature'] ?? '?'}°C)'
            : 'Visage inconnu détecté';
        setState(() {
          _alerteVisageInconnu = true;
          _nomAlerteVisage = identifie ? nomBrut : label;
          _alerteEmployeIdentifie = identifie;
          _alertePath = derniere.key;
          _matriculeAlerteVisage = (derniere.value['matricule'] as String?)?.trim();
        });
      } else {
        setState(() { _alerteVisageInconnu = false; _nomAlerteVisage = ''; _alertePath = null; _alerteEmployeIdentifie = false; _matriculeAlerteVisage = null; });
      }
    });
  }

  Future<void> _acquitterAlerte() async {
    if (_alertePath != null) {
      await _rtdb.ref('alerts/$_alertePath').update({'acknowledged': true});
    }
    setState(() { _alerteVisageInconnu = false; _nomAlerteVisage = ''; _alertePath = null; _alerteEmployeIdentifie = false; _matriculeAlerteVisage = null; });
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final screens = [
      _DashboardHome(
        position: _position,
        gpsLoading: _gpsLoading,
        gpsError: _gpsError,
        busId: _busId,
        busImmatriculation: _busImmatriculation,
        onRefreshGps: _startGpsStream,
      ),
      const ListeSalariesScreen(),
      _StatistiquesScreen(busId: _busId, busImmatriculation: _busImmatriculation),
    ];

    return Scaffold(
      backgroundColor: _kBg,
      appBar: _buildAppBar(auth),
      body: Stack(children: [
        screens[_selectedIndex],
        if (_alerteVisageInconnu)
          Positioned(
            top: 0, left: 0, right: 0,
            child: _AlerteVisageBanner(
              nom: _nomAlerteVisage,
              identifie: _alerteEmployeIdentifie,
              matricule: _matriculeAlerteVisage,
              onAcquitter: _acquitterAlerte,
            ),
          ),
      ]),
      bottomNavigationBar: _buildBottomNav(),
    );
  }

  AppBar _buildAppBar(AuthService auth) {
    return AppBar(
      backgroundColor: _kBlue,
      foregroundColor: Colors.white,
      elevation: 0,
      title: Row(children: [
        Container(
          width: 36, height: 36,
          decoration: BoxDecoration(
            color: Colors.white.withOpacity(0.15),
            borderRadius: BorderRadius.circular(10),
          ),
          child: const Icon(Icons.directions_bus_rounded, size: 20),
        ),
        const SizedBox(width: 12),
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('WICMIC Transport',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
          Text(auth.nom,
              style: const TextStyle(fontSize: 10, color: Colors.white60)),
        ]),
      ]),
      actions: [
        const Padding(padding: EdgeInsets.only(right: 4), child: _LiveClock()),
        IconButton(
          icon: _gpsLoading
              ? const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
              : Icon(
                  _position != null ? Icons.gps_fixed : Icons.gps_off,
                  size: 20,
                  color: _position != null ? Colors.greenAccent : Colors.white54,
                ),
          tooltip: _position != null
              ? '${_position!.latitude.toStringAsFixed(4)}, ${_position!.longitude.toStringAsFixed(4)}'
              : _gpsError.isNotEmpty ? _gpsError : 'Localiser',
          onPressed: _startGpsStream,
        ),
        if (_alerteVisageInconnu)
          IconButton(
            icon: const Icon(Icons.notifications_active, color: Colors.red, size: 22),
            onPressed: () => _showAlerteDetail(context),
          ),
        if (auth.isPrivilegie)
          IconButton(
            icon: const Icon(Icons.swap_horiz, size: 20),
            tooltip: 'Changer mon bus / circuit',
            onPressed: () => context.go('/chauffeur/choix-bus'),
          ),
        PopupMenuButton<String>(
          icon: const Icon(Icons.account_circle_outlined, size: 22),
          tooltip: 'Compte',
          onSelected: (value) {
            if (value == 'password') {
              _showChangePasswordDialog(context, context.read<AuthService>());
            } else if (value == 'logout') {
              _confirmLogout(context, context.read<AuthService>());
            }
          },
          itemBuilder: (context) => const [
            PopupMenuItem(
              value: 'password',
              child: Row(children: [
                Icon(Icons.key, size: 18),
                SizedBox(width: 10),
                Text('Changer mon mot de passe'),
              ]),
            ),
            PopupMenuItem(
              value: 'logout',
              child: Row(children: [
                Icon(Icons.logout, size: 18),
                SizedBox(width: 10),
                Text('Déconnexion'),
              ]),
            ),
          ],
        ),
      ],
    );
  }

  Future<void> _showChangePasswordDialog(BuildContext context, AuthService auth) async {
    final currentCtrl = TextEditingController();
    final newCtrl = TextEditingController();
    final confirmCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();
    bool saving = false;
    String? error;
    String? success;

    await showDialog<void>(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (dialogCtx, setDialogState) {
            return AlertDialog(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              title: const Text('Changer mon mot de passe'),
              content: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextFormField(
                      controller: currentCtrl,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: 'Mot de passe actuel'),
                      validator: (v) => (v == null || v.isEmpty) ? 'Requis' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: newCtrl,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: 'Nouveau mot de passe'),
                      validator: (v) {
                        if (v == null || v.isEmpty) return 'Requis';
                        if (v.length < 6) return '6 caractères minimum';
                        return null;
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: confirmCtrl,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: 'Confirmer le nouveau mot de passe'),
                      validator: (v) => (v != newCtrl.text) ? 'Les mots de passe ne correspondent pas' : null,
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 10),
                      Text(error!, style: const TextStyle(color: Colors.red, fontSize: 13)),
                    ],
                    if (success != null) ...[
                      const SizedBox(height: 10),
                      Text(success!, style: const TextStyle(color: Colors.green, fontSize: 13)),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(dialogCtx),
                  child: const Text('Fermer'),
                ),
                FilledButton(
                  onPressed: saving
                      ? null
                      : () async {
                          if (!formKey.currentState!.validate()) return;
                          setDialogState(() { saving = true; error = null; success = null; });
                          final err = await auth.changePassword(
                            currentPassword: currentCtrl.text,
                            newPassword: newCtrl.text,
                          );
                          setDialogState(() {
                            saving = false;
                            if (err != null) {
                              error = err;
                            } else {
                              success = 'Mot de passe modifié avec succès.';
                              currentCtrl.clear();
                              newCtrl.clear();
                              confirmCtrl.clear();
                            }
                          });
                        },
                  child: saving
                      ? const SizedBox(
                          width: 18, height: 18,
                          child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                        )
                      : const Text('Modifier'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  void _showAlerteDetail(BuildContext context) {
    showDialog(context: context, builder: (_) => AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      backgroundColor: Colors.red.shade50,
      title: const Row(children: [
        Icon(Icons.warning_amber_rounded, color: Colors.red),
        SizedBox(width: 8),
        Text('⚠ Visage inconnu détecté', style: TextStyle(color: Colors.red, fontSize: 15)),
      ]),
      content: Text('Une personne non reconnue a tenté de monter dans le bus.\n\nIdentifiant : $_nomAlerteVisage\n\nVérifiez immédiatement avant de continuer.',
          style: const TextStyle(fontSize: 13)),
      actions: [
        FilledButton.icon(
          style: FilledButton.styleFrom(backgroundColor: Colors.red),
          icon: const Icon(Icons.check),
          label: const Text('Acquitter'),
          onPressed: () { Navigator.pop(context); _acquitterAlerte(); },
        ),
      ],
    ));
  }

  Widget _buildBottomNav() {
    return BottomNavigationBar(
      type: BottomNavigationBarType.fixed,
      currentIndex: _selectedIndex,
      onTap: (i) => setState(() => _selectedIndex = i),
      selectedItemColor: _kBlueMid,
      unselectedItemColor: Colors.grey,
      selectedLabelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 11),
      items: const [
        BottomNavigationBarItem(icon: Icon(Icons.dashboard_outlined), activeIcon: Icon(Icons.dashboard), label: 'Tableau de bord'),
        BottomNavigationBarItem(icon: Icon(Icons.people_outline), activeIcon: Icon(Icons.people), label: 'Salariés'),
        BottomNavigationBarItem(icon: Icon(Icons.bar_chart_outlined), activeIcon: Icon(Icons.bar_chart), label: 'Statistiques'),
      ],
    );
  }

  Future<void> _confirmLogout(BuildContext ctx, AuthService auth) async {
    final ok = await showDialog<bool>(context: ctx, builder: (_) => AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      title: const Text('Se déconnecter ?'),
      content: const Text('Votre session sera fermée.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuler')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Déconnecter')),
      ],
    ));
    if (ok == true) { await auth.logout(); if (ctx.mounted) ctx.go('/login'); }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Bannière alerte visage
// ═════════════════════════════════════════════════════════════════════════════
class _AlerteVisageBanner extends StatefulWidget {
  final String nom; final bool identifie; final String? matricule; final VoidCallback onAcquitter;
  const _AlerteVisageBanner({required this.nom, required this.identifie, required this.onAcquitter, this.matricule});
  @override State<_AlerteVisageBanner> createState() => _AlerteVisageBannerState();
}
class _AlerteVisageBannerState extends State<_AlerteVisageBanner> with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<Color?> _colorAnim;
  @override void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 600))..repeat(reverse: true);
    _colorAnim = widget.identifie
        ? ColorTween(begin: Colors.orange.shade700, end: Colors.orange.shade400).animate(_ctrl)
        : ColorTween(begin: Colors.red.shade700, end: Colors.red.shade400).animate(_ctrl);
  }
  @override void dispose() { _ctrl.dispose(); super.dispose(); }
  @override Widget build(BuildContext context) {
    return AnimatedBuilder(animation: _colorAnim, builder: (_, __) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      color: _colorAnim.value,
      child: Row(children: [
        // Photo enrôlée de l'employé identifié (reconnaissance faciale), sinon icône générique.
        if (widget.identifie && (widget.matricule ?? '').isNotEmpty)
          _FacePhotoAvatar(
            matricule: widget.matricule!,
            radius: 15,
            fallbackIcon: Icons.how_to_reg,
            color: Colors.white,
            border: Colors.white,
          )
        else
          Icon(widget.identifie ? Icons.how_to_reg : Icons.face_retouching_off, color: Colors.white, size: 22),
        const SizedBox(width: 10),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.identifie ? '✓ PRÉSENCE ENREGISTRÉE — ALERTE' : '⚠ VISAGE NON RECONNU',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
          Text(widget.nom, style: const TextStyle(color: Colors.white70, fontSize: 11)),
        ])),
        GestureDetector(onTap: widget.onAcquitter, child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(color: Colors.white.withOpacity(0.2), borderRadius: BorderRadius.circular(8)),
          child: const Text('OK', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        )),
      ]),
    ));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Photo de visage enrôlée (Firestore face_enrollments/{matricule}.photo_url)
//  Utilisée pour illustrer les pointages/alertes détectés par reconnaissance
//  faciale (système). Le pointage manuel ne passe jamais par ce widget.
// ═════════════════════════════════════════════════════════════════════════════
class _FacePhotoAvatar extends StatelessWidget {
  final String matricule;
  final double radius;
  final IconData fallbackIcon;
  final Color color;
  final Color? border;
  const _FacePhotoAvatar({
    required this.matricule,
    required this.fallbackIcon,
    required this.color,
    this.radius = 14,
    this.border,
  });

  @override
  Widget build(BuildContext context) {
    Widget fallback() => CircleAvatar(
          radius: radius,
          backgroundColor: color.withOpacity(0.12),
          child: Icon(fallbackIcon, size: radius, color: color),
        );

    if (matricule.isEmpty) return fallback();

    return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      future: FirebaseFirestore.instance.collection('face_enrollments').doc(matricule).get(),
      builder: (context, snap) {
        final url = snap.data?.data()?['photo_url'] as String?;
        if (url == null || url.isEmpty) return fallback();
        final avatar = CircleAvatar(
          radius: radius,
          backgroundColor: color.withOpacity(0.12),
          backgroundImage: NetworkImage(url),
          onBackgroundImageError: (_, __) {},
        );
        if (border == null) return avatar;
        return Container(
          padding: const EdgeInsets.all(1.5),
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: border!, width: 1.5)),
          child: avatar,
        );
      },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Horloge temps réel
// ═════════════════════════════════════════════════════════════════════════════
class _LiveClock extends StatefulWidget {
  const _LiveClock();
  @override State<_LiveClock> createState() => _LiveClockState();
}
class _LiveClockState extends State<_LiveClock> {
  late String _time, _date;
  Timer? _timer;
  @override void initState() { super.initState(); _update(); _timer = Timer.periodic(const Duration(seconds: 1), (_) => _update()); }
  void _update() { final now = DateTime.now(); setState(() { _time = DateFormat('HH:mm:ss').format(now); _date = DateFormat('EEE d MMM', 'fr').format(now); }); }
  @override void dispose() { _timer?.cancel(); super.dispose(); }
  @override Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: Colors.white.withOpacity(0.15), borderRadius: BorderRadius.circular(8)),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(_time, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.white)),
        Text(_date, style: const TextStyle(fontSize: 8, color: Colors.white70)),
      ]),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Dashboard Home (onglet 0)
// ═════════════════════════════════════════════════════════════════════════════
class _DashboardHome extends StatelessWidget {
  final Position? position;
  final bool gpsLoading;
  final String gpsError;
  final String busId;
  final String busImmatriculation;
  final VoidCallback onRefreshGps;

  const _DashboardHome({
    required this.position, required this.gpsLoading,
    required this.gpsError, required this.busId,
    required this.busImmatriculation,
    required this.onRefreshGps,
  });

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final uid = auth.uid;
    if (auth.isLoading || uid.isEmpty) return const Center(child: CircularProgressIndicator());

    return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      stream: FirebaseFirestore.instance.collection('conducteurs').doc(uid).snapshots(),
      builder: (context, snapCond) {
        final cond = snapCond.data?.data() ?? {};
        final conducteurBusId = cond['bus_id'] as String? ?? busId;

        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 80),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [

            // ── Carte affectation Bus + Circuit ───────────────────────────
            _SectionLabel(label: 'Mon affectation'),
            const SizedBox(height: 8),
            _AffectationCard(uid: uid, nom: auth.nom, busId: conducteurBusId, privilegie: auth.isPrivilegie),
            const SizedBox(height: 16),

            // ── Distance parcourue cette semaine ──────────────────────────
            if (conducteurBusId.isNotEmpty) ...[
              _SectionLabel(label: 'Distance cette semaine'),
              const SizedBox(height: 8),
              _DistanceSemaine(busId: conducteurBusId),
              const SizedBox(height: 16),
            ],

            // ── GPS ───────────────────────────────────────────────────────
            _SectionLabel(label: 'GPS • Position temps réel'),
            const SizedBox(height: 8),
            _GpsDashboard(position: position, gpsLoading: gpsLoading, gpsError: gpsError, onRefresh: onRefreshGps),
            const SizedBox(height: 16),

            // ── Présences du jour ─────────────────────────────────────────
            _SectionLabel(label: "Présences aujourd'hui"),
            const SizedBox(height: 8),
            _PresencesSummaryCard(busId: conducteurBusId, busImmatriculation: busImmatriculation),
            const SizedBox(height: 16),

            // ── Alertes récentes (visage inconnu / fièvre, caméra Raspberry Pi) ──
            _SectionLabel(label: 'Alertes récentes'),
            const SizedBox(height: 8),
            _RecentAlertsCard(busId: conducteurBusId),
            const SizedBox(height: 16),

            // ── Actions rapides ───────────────────────────────────────────
            _SectionLabel(label: 'Actions rapides'),
            const SizedBox(height: 8),
            Row(children: [
              _ActionCard(icon: Icons.people, label: 'Liste salariés', color: _kBlueMid, onTap: () {
                final state = context.findAncestorStateOfType<_ChauffeurDashboardState>();
                state?.setState(() => state._selectedIndex = 1);
              }),
              const SizedBox(width: 10),
              _ActionCard(icon: Icons.bar_chart, label: 'Statistiques', color: Colors.teal, onTap: () {
                final state = context.findAncestorStateOfType<_ChauffeurDashboardState>();
                state?.setState(() => state._selectedIndex = 2);
              }),
            ]),
          ]),
        );
      },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Carte affectation : conducteur + bus (depuis buses) + circuit (depuis buses)
// ═════════════════════════════════════════════════════════════════════════════
class _AffectationCard extends StatelessWidget {
  final String uid, nom, busId;
  final bool privilegie;
  const _AffectationCard({required this.uid, required this.nom, required this.busId, this.privilegie = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [_kBlue, _kBlueLite],
            begin: Alignment.topLeft, end: Alignment.bottomRight),
        borderRadius: BorderRadius.circular(20),
        boxShadow: [BoxShadow(color: _kBlueMid.withOpacity(0.3), blurRadius: 14, offset: const Offset(0, 5))],
      ),
      child: busId.isEmpty
          // Pas de bus assigné
          ? Padding(
              padding: const EdgeInsets.all(20),
              child: Row(children: [
                Container(width: 48, height: 48,
                    decoration: BoxDecoration(color: Colors.white.withOpacity(0.15), shape: BoxShape.circle),
                    child: const Icon(Icons.person, color: Colors.white, size: 26)),
                const SizedBox(width: 14),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_salutation(), style: const TextStyle(color: Colors.white60, fontSize: 11)),
                  Text(nom, style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(color: Colors.orange.withOpacity(0.3), borderRadius: BorderRadius.circular(8)),
                    child: const Text('⚠ Aucun bus assigné', style: TextStyle(color: Colors.white, fontSize: 11)),
                  ),
                  const SizedBox(height: 10),
                  if (privilegie)
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: () => context.go('/chauffeur/choix-bus'),
                        icon: const Icon(Icons.touch_app, size: 16),
                        label: const Text('Choisir mon bus'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.white,
                          foregroundColor: _kBlue,
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
                      ),
                    )
                  else
                    const Text(
                      "En attente d'affectation par l'admin…",
                      style: TextStyle(color: Colors.white70, fontSize: 11.5, fontStyle: FontStyle.italic),
                    ),
                ])),
              ]),
            )
          // Bus assigné → charger bus et son circuit en stream
          : StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
              stream: FirebaseFirestore.instance.collection('buses').doc(busId).snapshots(),
              builder: (ctx, snapBus) {
                final bus = snapBus.data?.data() ?? {};
                final circuitId = bus['circuit_id'] as String? ?? '';

                return Column(children: [
                  // Ligne conducteur
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 18, 18, 12),
                    child: Row(children: [
                      Container(width: 48, height: 48,
                          decoration: BoxDecoration(color: Colors.white.withOpacity(0.18), shape: BoxShape.circle),
                          child: const Icon(Icons.person, color: Colors.white, size: 26)),
                      const SizedBox(width: 14),
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(_salutation(), style: const TextStyle(color: Colors.white60, fontSize: 11)),
                        Text(nom, style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
                        const Text('Conducteur', style: TextStyle(color: Colors.white54, fontSize: 11)),
                      ])),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(color: Colors.white.withOpacity(0.15), borderRadius: BorderRadius.circular(8)),
                        child: Text(DateFormat('HH:mm').format(DateTime.now()),
                            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
                      ),
                    ]),
                  ),
                  Divider(color: Colors.white.withOpacity(0.15), height: 1),
                  // Infos bus + circuit
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(children: [
                      // BUS
                      Expanded(child: _InfoTile(
                        icon: Icons.directions_bus_rounded,
                        label: 'Bus',
                        value: bus['immatriculation'] as String? ?? busId,
                        sub: '${bus['marque'] ?? ''} ${bus['modele'] ?? ''}'.trim(),
                      )),
                      Container(width: 1, height: 48, color: Colors.white.withOpacity(0.2)),
                      // CIRCUIT (depuis le bus, pas le conducteur)
                      Expanded(child: circuitId.isNotEmpty
                          ? FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
                              future: FirebaseFirestore.instance.collection('circuits').doc(circuitId).get(),
                              builder: (_, snap) {
                                final d = snap.data?.data() ?? {};
                                return _InfoTile(
                                  icon: Icons.route,
                                  label: 'Circuit',
                                  value: d['code'] as String? ?? circuitId,
                                  sub: d['designation'] as String? ?? '',
                                );
                              },
                            )
                          : const _InfoTile(icon: Icons.route, label: 'Circuit', value: 'Non assigné', sub: ''),
                      ),
                    ]),
                  ),
                  // Stations du circuit
                  if (circuitId.isNotEmpty) ...[
                    Divider(color: Colors.white.withOpacity(0.1), height: 1),
                    _StationsInline(circuitId: circuitId),
                  ],
                ]);
              },
            ),
    );
  }

  String _salutation() {
    final h = DateTime.now().hour;
    if (h < 12) return 'Bonjour,';
    if (h < 18) return 'Bon après-midi,';
    return 'Bonsoir,';
  }
}

class _InfoTile extends StatelessWidget {
  final IconData icon;
  final String label, value, sub;
  const _InfoTile({required this.icon, required this.label, required this.value, required this.sub});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(children: [
        Icon(icon, color: Colors.white70, size: 18),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(color: Colors.white54, fontSize: 10)),
        const SizedBox(height: 2),
        Text(value, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
            textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis),
        if (sub.isNotEmpty)
          Text(sub, style: const TextStyle(color: Colors.white60, fontSize: 10),
              textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis),
      ]),
    );
  }
}

// Stations affichées compactement dans la carte
class _StationsInline extends StatelessWidget {
  final String circuitId;
  const _StationsInline({required this.circuitId});
  @override
  Widget build(BuildContext context) {
    return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      future: FirebaseFirestore.instance.collection('circuits').doc(circuitId).get(),
      builder: (_, snap) {
        final d = snap.data?.data() ?? {};
        final stations = (d['arrets'] as List<dynamic>?)?.cast<String>() ?? [];
        if (stations.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${stations.length} arrêts', style: const TextStyle(color: Colors.white60, fontSize: 11)),
            const SizedBox(height: 6),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: List.generate(stations.length, (i) {
                final isFirst = i == 0;
                final isLast = i == stations.length - 1;
                return Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: isFirst ? Colors.green.withOpacity(0.3)
                          : isLast ? Colors.red.withOpacity(0.3)
                          : Colors.white.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(stations[i],
                        style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w500)),
                  ),
                  if (!isLast) const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4),
                    child: Icon(Icons.arrow_forward_ios, size: 8, color: Colors.white38),
                  ),
                ]);
              })),
            ),
          ]),
        );
      },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Distance parcourue cette semaine
// ═════════════════════════════════════════════════════════════════════════════
class _DistanceSemaine extends StatelessWidget {
  final String busId;
  final String periode; // "Aujourd'hui" | 'Semaine' | 'Mois'
  const _DistanceSemaine({required this.busId, this.periode = 'Semaine'});

  List<String> get _dateKeys {
    final now = DateTime.now();
    switch (periode) {
      case "Aujourd'hui":
        return [_todayKey];
      case 'Mois':
        final first = DateTime(now.year, now.month, 1);
        final nbJours = now.difference(first).inDays + 1;
        return List.generate(nbJours, (i) {
          final d = first.add(Duration(days: i));
          return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
        });
      case 'Semaine':
      default:
        return _weekKeys;
    }
  }

  String get _titre {
    switch (periode) {
      case "Aujourd'hui": return 'Distance du jour';
      case 'Mois': return 'Distance du mois';
      default: return 'Distance semaine';
    }
  }

  String get _sousTitre {
    final now = DateTime.now();
    switch (periode) {
      case "Aujourd'hui": return DateFormat('EEEE d MMMM', 'fr').format(now);
      case 'Mois': return 'Depuis le 1er ${DateFormat('MMMM', 'fr').format(now)}';
      default: return 'Lundi → aujourd\'hui';
    }
  }

  Future<Map<String, double>> _calcDistances() async {
    final db = FirebaseFirestore.instance;
    final Map<String, double> result = {};

    for (final dateKey in _dateKeys) {
      try {
        final snap = await db
            .collection('buses')
            .doc(busId)
            .collection('gps_points')
            .doc(dateKey)
            .collection('points')
            .orderBy('ts')
            .get();

        final docs = snap.docs;
        double dist = 0;
        for (int i = 1; i < docs.length; i++) {
          final a = docs[i - 1].data();
          final b = docs[i].data();
          final lat1 = (a['lat'] as num).toDouble();
          final lon1 = (a['lng'] as num).toDouble();
          final lat2 = (b['lat'] as num).toDouble();
          final lon2 = (b['lng'] as num).toDouble();
          final d = _haversine(lat1, lon1, lat2, lon2);
          if (d < 500) dist += d; // ignorer les sauts > 500m (perte GPS)
        }
        result[dateKey] = dist / 1000; // km
      } catch (_) {
        result[dateKey] = 0;
      }
    }
    return result;
  }

  @override
  Widget build(BuildContext context) {
    final dateKeys = _dateKeys;
    return FutureBuilder<Map<String, double>>(
      future: _calcDistances(),
      builder: (ctx, snap) {
        final distances = snap.data ?? {};
        final totalKm = distances.values.fold(0.0, (a, b) => a + b);
        final maxKm = distances.values.isEmpty ? 1.0
            : distances.values.reduce(math.max).clamp(1.0, double.infinity);
        final dayLabels = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8)],
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: Colors.teal.shade50, borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.route, color: Colors.teal, size: 18),
              ),
              const SizedBox(width: 10),
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_titre, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                Text(_sousTitre, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
              ]),
              const Spacer(),
              if (snap.connectionState == ConnectionState.waiting)
                const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              else
                Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text('${totalKm.toStringAsFixed(1)} km',
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: Colors.teal)),
                  const Text('total', style: TextStyle(fontSize: 10, color: Colors.grey)),
                ]),
            ]),
            if (snap.hasData && distances.isNotEmpty && dateKeys.length > 1) ...[
              const SizedBox(height: 16),
              // Graphe barres (semaine : L→D, mois : jour par jour, défilable)
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: List.generate(dateKeys.length, (i) {
                    final key = dateKeys[i];
                    final km = distances[key] ?? 0;
                    final isToday = key == _todayKey;
                    final barH = km == 0 ? 4.0 : (km / maxKm * 60).clamp(4.0, 60.0);
                    final label = periode == 'Semaine'
                        ? (i < dayLabels.length ? dayLabels[i] : '')
                        : '${i + 1}';
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: SizedBox(
                        width: periode == 'Semaine' ? null : 22,
                        child: Column(mainAxisSize: MainAxisSize.min, children: [
                          if (km > 0)
                            Text(km.toStringAsFixed(0),
                                style: TextStyle(fontSize: 9, color: isToday ? Colors.teal : Colors.grey[500])),
                          const SizedBox(height: 2),
                          Container(
                            width: periode == 'Semaine' ? 28 : 14,
                            height: barH,
                            decoration: BoxDecoration(
                              color: isToday ? Colors.teal : Colors.teal.shade100,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(label,
                              style: TextStyle(fontSize: 10,
                                  fontWeight: isToday ? FontWeight.bold : FontWeight.normal,
                                  color: isToday ? Colors.teal : Colors.grey)),
                        ]),
                      ),
                    );
                  }),
                ),
              ),
            ],
          ]),
        );
      },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  GPS Dashboard
// ═════════════════════════════════════════════════════════════════════════════
class _GpsDashboard extends StatefulWidget {
  final Position? position;
  final bool gpsLoading;
  final String gpsError;
  final VoidCallback onRefresh;
  const _GpsDashboard({required this.position, required this.gpsLoading, required this.gpsError, required this.onRefresh});
  @override State<_GpsDashboard> createState() => _GpsDashboardState();
}
class _GpsDashboardState extends State<_GpsDashboard> {
  final MapController _mapCtrl = MapController();
  bool _mapReady = false;
  @override
  void didUpdateWidget(_GpsDashboard old) {
    super.didUpdateWidget(old);
    if (_mapReady && widget.position != null) {
      final p = widget.position!;
      _mapCtrl.move(LatLng(p.latitude, p.longitude), _mapCtrl.camera.zoom);
    }
  }
  @override
  Widget build(BuildContext context) {
    final hasGps = widget.position != null;
    final pos = widget.position;
    return Container(
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16),
          boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 10)]),
      clipBehavior: Clip.hardEdge,
      child: Column(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          color: hasGps ? Colors.green.shade50 : Colors.grey.shade50,
          child: Row(children: [
            Container(padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: hasGps ? Colors.green.shade100 : Colors.grey.shade200, shape: BoxShape.circle),
                child: Icon(hasGps ? Icons.gps_fixed : Icons.gps_not_fixed,
                    color: hasGps ? Colors.green.shade700 : Colors.grey, size: 16)),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(hasGps ? 'GPS actif — temps réel' : (widget.gpsLoading ? 'Localisation en cours...' : 'GPS inactif'),
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13,
                      color: hasGps ? Colors.green.shade800 : Colors.grey[700])),
              if (hasGps)
                Text('${pos!.latitude.toStringAsFixed(5)}, ${pos.longitude.toStringAsFixed(5)}  ·  ±${pos.accuracy.toStringAsFixed(0)} m',
                    style: TextStyle(fontSize: 10, color: Colors.grey[600]))
              else if (widget.gpsError.isNotEmpty)
                Text(widget.gpsError, style: const TextStyle(fontSize: 10, color: Colors.red)),
            ])),
            if (hasGps && pos!.speed > 0.5)
              Container(
                margin: const EdgeInsets.only(right: 8),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(color: _kBlueMid.withOpacity(0.1), borderRadius: BorderRadius.circular(8)),
                child: Row(children: [
                  const Icon(Icons.speed, color: _kBlueMid, size: 13),
                  const SizedBox(width: 4),
                  Text('${(pos!.speed * 3.6).toStringAsFixed(0)} km/h',
                      style: const TextStyle(color: _kBlueMid, fontWeight: FontWeight.bold, fontSize: 12)),
                ]),
              ),
            GestureDetector(onTap: widget.onRefresh, child: Container(
              padding: const EdgeInsets.all(7),
              decoration: BoxDecoration(color: _kBlue.withOpacity(0.08), borderRadius: BorderRadius.circular(8)),
              child: widget.gpsLoading
                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: _kBlueMid))
                  : const Icon(Icons.my_location, color: _kBlueMid, size: 16),
            )),
          ]),
        ),
        SizedBox(
          height: 240,
          child: hasGps
              ? Stack(children: [
                  FlutterMap(
                    mapController: _mapCtrl,
                    options: MapOptions(
                      initialCenter: LatLng(pos!.latitude, pos.longitude),
                      initialZoom: 15.5,
                      onMapReady: () => setState(() => _mapReady = true),
                    ),
                    children: [
                      TileLayer(urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                          userAgentPackageName: 'com.wicmic.transport', maxZoom: 19),
                      CircleLayer(circles: [CircleMarker(
                        point: LatLng(pos.latitude, pos.longitude),
                        radius: pos.accuracy, useRadiusInMeter: true,
                        color: Colors.blue.withOpacity(0.12), borderColor: Colors.blue.withOpacity(0.4), borderStrokeWidth: 1.5,
                      )]),
                      MarkerLayer(markers: [Marker(
                        point: LatLng(pos.latitude, pos.longitude), width: 48, height: 48,
                        child: _BusMapMarker(),
                      )]),
                    ],
                  ),
                  Positioned(right: 10, bottom: 10, child: Column(children: [
                    _MapBtn(icon: Icons.add, onTap: () => _mapCtrl.move(_mapCtrl.camera.center, _mapCtrl.camera.zoom + 1)),
                    const SizedBox(height: 4),
                    _MapBtn(icon: Icons.remove, onTap: () => _mapCtrl.move(_mapCtrl.camera.center, _mapCtrl.camera.zoom - 1)),
                    const SizedBox(height: 4),
                    _MapBtn(icon: Icons.my_location, onTap: () => _mapCtrl.move(LatLng(pos.latitude, pos.longitude), 15.5)),
                  ])),
                  Positioned(left: 0, bottom: 0, child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                    color: Colors.white.withOpacity(0.7),
                    child: const Text('© OpenStreetMap contributors', style: TextStyle(fontSize: 8, color: Colors.black54)),
                  )),
                ])
              : Container(color: Colors.grey.shade100, child: Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(Icons.map_outlined, size: 48, color: Colors.grey.shade400),
                  const SizedBox(height: 10),
                  Text(widget.gpsLoading ? 'Acquisition GPS en cours...' : 'Position non disponible',
                      style: TextStyle(color: Colors.grey.shade500, fontSize: 13)),
                  if (!widget.gpsLoading) ...[
                    const SizedBox(height: 12),
                    TextButton.icon(onPressed: widget.onRefresh,
                        icon: const Icon(Icons.my_location, size: 16), label: const Text('Activer le GPS')),
                  ] else ...[
                    const SizedBox(height: 12),
                    const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)),
                  ],
                ]))),
        ),
        if (hasGps)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(border: Border(top: BorderSide(color: Colors.grey.shade100))),
            child: Row(children: [
              _GpsMetric(label: 'Latitude', value: pos!.latitude.toStringAsFixed(6), icon: Icons.north),
              _GpsMetric(label: 'Longitude', value: pos.longitude.toStringAsFixed(6), icon: Icons.east),
              _GpsMetric(label: 'Précision', value: '±${pos.accuracy.toStringAsFixed(0)} m', icon: Icons.radar, highlight: pos.accuracy < 20),
              if (pos.altitude != 0)
                _GpsMetric(label: 'Altitude', value: '${pos.altitude.toStringAsFixed(0)} m', icon: Icons.terrain),
            ]),
          ),
      ]),
    );
  }
}

class _BusMapMarker extends StatelessWidget {
  @override Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(color: _kBlue, shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 3),
        boxShadow: [BoxShadow(color: _kBlue.withOpacity(0.4), blurRadius: 8, spreadRadius: 2)]),
    child: const Icon(Icons.directions_bus, color: Colors.white, size: 22),
  );
}

class _MapBtn extends StatelessWidget {
  final IconData icon; final VoidCallback onTap;
  const _MapBtn({required this.icon, required this.onTap});
  @override Widget build(BuildContext context) => GestureDetector(onTap: onTap, child: Container(
    width: 34, height: 34,
    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.15), blurRadius: 4)]),
    child: Icon(icon, size: 18, color: Colors.black87),
  ));
}

class _GpsMetric extends StatelessWidget {
  final String label, value; final IconData icon; final bool highlight;
  const _GpsMetric({required this.label, required this.value, required this.icon, this.highlight = false});
  @override Widget build(BuildContext context) => Expanded(child: Column(children: [
    Icon(icon, size: 13, color: highlight ? Colors.green : Colors.grey),
    const SizedBox(height: 2),
    Text(value, style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold,
        color: highlight ? Colors.green.shade700 : Colors.black87), textAlign: TextAlign.center),
    Text(label, style: TextStyle(fontSize: 9, color: Colors.grey[500]), textAlign: TextAlign.center),
  ]));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Résumé présences du jour
// ═════════════════════════════════════════════════════════════════════════════
class _PresencesSummaryCard extends StatelessWidget {
  final String busId;
  final String busImmatriculation;
  const _PresencesSummaryCard({required this.busId, required this.busImmatriculation});
  @override
  Widget build(BuildContext context) {
    if (busImmatriculation.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
        child: const Text('En attente du bus…', style: TextStyle(color: Colors.grey, fontSize: 12)),
      );
    }
    return StreamBuilder<DatabaseEvent>(
      stream: _rtdb.ref('attendance/$busImmatriculation/$_todayKey').onValue,
      builder: (context, snapAtt) {
        return StreamBuilder<DatabaseEvent>(
          stream: _rtdb.ref('manual_checkins/$_todayKey').onValue,
          builder: (context, snapManual) {
            return StreamBuilder<DatabaseEvent>(
              stream: _rtdb.ref('alerts').onValue,
              builder: (context, snapAlerts) {
        int presents = 0, inconnus = 0, fievres = 0;
        String? dernierHeure, dernierNom;
        final presenceMap = _buildPresenceMapByMatricule(
          attendanceRaw: snapAtt.data?.snapshot.value,
          manualCheckinsRaw: snapManual.data?.snapshot.value,
          busId: busId,
          todayKey: _todayKey,
        );
        presenceMap.forEach((_, e) {
            presents++;
            final t = (e['temperature'] as num?)?.toDouble() ?? 0;
            if (t > 37.5) fievres++;
            final tsStr = e['timestamp'] as String?;
            if (tsStr != null) try {
              final dt = DateTime.parse(tsStr);
              if (dernierHeure == null || dt.isAfter(DateTime.parse(dernierHeure!))) { dernierHeure = tsStr; dernierNom = e['nom'] as String? ?? ''; }
            } catch (_) {}
        });

        // Alertes du jour pour ce bus (visage inconnu / température),
        // y compris celles sans matricule (ex: alert_type "unknown").
        final alertesToday = _flattenRtdbRecords(snapAlerts.data?.snapshot.value)
            .where((a) => a['bus_id'] == busId && _dateKeyOf(a) == _todayKey)
            .toList();
        inconnus = alertesToday.where((a) => a['alert_type'] == 'unknown').length;
        final fievresAlertes = alertesToday.where((a) => a['alert_type'] == 'fever').length;
        fievres = fievres > fievresAlertes ? fievres : fievresAlertes;

        String? heureFmt;
        if (dernierHeure != null) try { heureFmt = DateFormat('HH:mm').format(DateTime.parse(dernierHeure!)); } catch (_) {}
        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16),
              boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8)]),
          child: Column(children: [
            Row(children: [
              _PresenceTile(icon: Icons.check_circle, label: 'Présents', value: '$presents', color: Colors.green),
              _PresenceTile(icon: Icons.thermostat, label: 'Fièvres', value: '$fievres', color: fievres > 0 ? Colors.red : Colors.grey),
              _PresenceTile(icon: Icons.face_retouching_off, label: 'Inconnus', value: '$inconnus', color: inconnus > 0 ? Colors.orange : Colors.grey),
            ]),
            if (dernierNom != null && heureFmt != null) ...[
              const SizedBox(height: 12), const Divider(height: 1), const SizedBox(height: 10),
              Row(children: [
                const Icon(Icons.history, size: 14, color: Colors.grey), const SizedBox(width: 6),
                Text('Dernier : $dernierNom', style: const TextStyle(fontSize: 12, color: Colors.black87)),
                const Spacer(),
                Text(heureFmt, style: const TextStyle(fontWeight: FontWeight.bold, color: _kBlueMid, fontSize: 13)),
              ]),
            ],
          ]),
        );
              },
            );
          },
        );
      },
    );
  }
}

class _PresenceTile extends StatelessWidget {
  final IconData icon; final String label, value; final Color color;
  const _PresenceTile({required this.icon, required this.label, required this.value, required this.color});
  @override Widget build(BuildContext context) => Expanded(child: Column(children: [
    Icon(icon, color: color, size: 22), const SizedBox(height: 4),
    Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: color)),
    Text(label, style: const TextStyle(fontSize: 10, color: Colors.black54)),
  ]));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Alertes récentes (visage inconnu / fièvre — caméra Raspberry Pi)
//  Reprend la logique du panneau "Recent Alerts" du dashboard web, appliquée
//  au bus du conducteur connecté. Basé sur RTDB 'alerts', déjà utilisé pour
//  la bannière et les compteurs "Inconnus" / "Fièvres".
// ═════════════════════════════════════════════════════════════════════════════
class _RecentAlertsCard extends StatelessWidget {
  final String busId;
  const _RecentAlertsCard({required this.busId});

  @override
  Widget build(BuildContext context) {
    if (busId.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
        child: const Text('En attente du bus…', style: TextStyle(color: Colors.grey, fontSize: 12)),
      );
    }
    return StreamBuilder<DatabaseEvent>(
      stream: _rtdb.ref('alerts').onValue,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
            child: const Center(child: CircularProgressIndicator()),
          );
        }
        final alertesJour = _flattenRtdbRecords(snap.data?.snapshot.value)
            .where((a) => a['bus_id'] == busId && _dateKeyOf(a) == _todayKey)
            .toList()
          ..sort((a, b) => (b['timestamp'] as String? ?? '').compareTo(a['timestamp'] as String? ?? ''));
        final recentes = alertesJour.take(5).toList();

        return Container(
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16),
              boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8)]),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
              child: Row(children: [
                Container(
                  padding: const EdgeInsets.all(7),
                  decoration: BoxDecoration(
                    color: (alertesJour.isNotEmpty ? Colors.red : Colors.grey).withOpacity(0.1),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(Icons.shield_outlined, size: 15,
                      color: alertesJour.isNotEmpty ? Colors.red : Colors.grey),
                ),
                const SizedBox(width: 10),
                const Text('Alertes récentes', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                  decoration: BoxDecoration(
                    color: (alertesJour.isNotEmpty ? Colors.red : Colors.grey).withOpacity(0.1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text('${alertesJour.length}', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold,
                      color: alertesJour.isNotEmpty ? Colors.red : Colors.grey[600])),
                ),
              ]),
            ),
            const Divider(height: 1),
            if (recentes.isEmpty)
              const Padding(
                padding: EdgeInsets.all(20),
                child: Center(child: Text("Aucune alerte aujourd'hui", style: TextStyle(color: Colors.grey, fontSize: 12))),
              )
            else
              ...recentes.map((a) {
                final type = a['alert_type'] as String? ?? 'unknown';
                final isFever = type == 'fever';
                final tsStr = a['timestamp'] as String?;
                DateTime? dt; try { if (tsStr != null) dt = DateTime.parse(tsStr); } catch (_) {}
                // On n'affiche le nom / les détails que si l'employé a bien été
                // identifié par la reconnaissance faciale (champ 'nom' présent).
                // Sinon (visage vraiment inconnu), on reste sur un libellé générique.
                final nomBrut = (a['nom'] as String?)?.trim();
                final estIdentifie = nomBrut != null && nomBrut.isNotEmpty;
                final titre = estIdentifie ? nomBrut : 'Visage inconnu';
                return Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                  child: Row(children: [
                    Icon(isFever ? Icons.thermostat : Icons.face_retouching_off, size: 15,
                        color: isFever ? Colors.red : Colors.orange),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [
                          Text(titre,
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12)),
                          const SizedBox(width: 6),
                          if (estIdentifie)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: Colors.green.withOpacity(0.12),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: const Text('enregistré',
                                  style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Colors.green)),
                            ),
                          const SizedBox(width: 4),
                          if (isFever)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: Colors.red.withOpacity(0.12),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: const Text('fièvre',
                                  style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Colors.red)),
                            )
                          else if (!estIdentifie)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: Colors.orange.withOpacity(0.12),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: const Text('inconnu',
                                  style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Colors.orange)),
                            ),
                        ]),
                        const SizedBox(height: 2),
                        Text(dt != null ? DateFormat('HH:mm:ss').format(dt) : '--',
                            style: TextStyle(fontSize: 10, color: Colors.grey[500])),
                      ]),
                    ),
                  ]),
                );
              }),
            const SizedBox(height: 4),
          ]),
        );
      },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Helpers visuels communs
// ═════════════════════════════════════════════════════════════════════════════
class _SectionLabel extends StatelessWidget {
  final String label;
  const _SectionLabel({required this.label});
  @override Widget build(BuildContext context) => Row(children: [
    Container(width: 3, height: 16, decoration: BoxDecoration(color: _kBlueMid, borderRadius: BorderRadius.circular(2))),
    const SizedBox(width: 8),
    Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF1A237E))),
  ]);
}

class _ActionCard extends StatelessWidget {
  final IconData icon; final String label; final Color color; final VoidCallback onTap;
  const _ActionCard({required this.icon, required this.label, required this.color, required this.onTap});
  @override Widget build(BuildContext context) => Expanded(child: GestureDetector(onTap: onTap, child: Container(
    padding: const EdgeInsets.symmetric(vertical: 18),
    decoration: BoxDecoration(color: color.withOpacity(0.09), borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withOpacity(0.2))),
    child: Column(children: [
      Icon(icon, color: color, size: 28), const SizedBox(height: 8),
      Text(label, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: color), textAlign: TextAlign.center),
    ]),
  )));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Écran Statistiques (onglet 2)
// ═════════════════════════════════════════════════════════════════════════════
class _StatistiquesScreen extends StatefulWidget {
  final String busId;
  final String busImmatriculation;
  const _StatistiquesScreen({required this.busId, required this.busImmatriculation});
  @override State<_StatistiquesScreen> createState() => _StatistiquesScreenState();
}

class _StatistiquesScreenState extends State<_StatistiquesScreen> {
  String _filtre = "Aujourd'hui";

  DateTimeRange _getRange() {
    final now = DateTime.now();
    switch (_filtre) {
      case 'Semaine':
        final start = now.subtract(Duration(days: now.weekday - 1));
        return DateTimeRange(start: DateTime(start.year, start.month, start.day), end: now);
      case 'Mois':
        return DateTimeRange(start: DateTime(now.year, now.month, 1), end: now);
      default:
        return DateTimeRange(start: DateTime(now.year, now.month, now.day), end: now);
    }
  }

  @override
  Widget build(BuildContext context) {
    final range = _getRange();
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
        child: Row(children: ["Aujourd'hui", 'Semaine', 'Mois'].map((label) {
          final selected = _filtre == label;
          return Padding(padding: const EdgeInsets.only(right: 8), child: GestureDetector(
            onTap: () => setState(() => _filtre = label),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: BoxDecoration(
                color: selected ? _kBlueMid : Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: selected ? _kBlueMid : Colors.grey.shade300),
              ),
              child: Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600,
                  color: selected ? Colors.white : Colors.grey[600])),
            ),
          ));
        }).toList()),
      ),
      const SizedBox(height: 12),
      Expanded(child: StreamBuilder<DatabaseEvent>(
        stream: widget.busImmatriculation.isEmpty
            ? const Stream<DatabaseEvent>.empty()
            : _rtdb.ref('attendance/${widget.busImmatriculation}').onValue,
        builder: (context, snapAtt) {
          return StreamBuilder<DatabaseEvent>(
            stream: _rtdb.ref('manual_checkins').onValue,
            builder: (context, snapManual) {
              return StreamBuilder<DatabaseEvent>(
                stream: _rtdb.ref('alerts').onValue,
                builder: (context, snapAlerts) {
          if (snapManual.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          final allPresences = <Map<String, dynamic>>[];
          // Les enregistrements de reconnaissance faciale n'ont pas toujours de
          // champ 'timestamp' (la date/heure est encodée dans le chemin RTDB et/ou
          // des champs 'date'/'time' séparés) : on se base sur _dateKeyOf (déjà
          // robuste à ce sujet) plutôt que sur 'timestamp' seul, sans quoi les
          // pointages système anciens n'apparaissent jamais, quel que soit le filtre.
          bool inRange(Map<String, dynamic> rec) {
            final dateKey = _dateKeyOf(rec);
            if (dateKey.isEmpty) return false;
            final parts = dateKey.split('-');
            if (parts.length != 3) return false;
            try {
              final d = DateTime(int.parse(parts[0]), int.parse(parts[1]), int.parse(parts[2]));
              final startDay = DateTime(range.start.year, range.start.month, range.start.day);
              final endDay = DateTime(range.end.year, range.end.month, range.end.day);
              return !d.isBefore(startDay) && !d.isAfter(endDay);
            } catch (_) {
              return false;
            }
          }

          // 'attendance' est déjà scopé à ce bus via le chemin
          // attendance/{immatriculation}/... : pas de champ bus_id à vérifier.
          if (snapAtt.data?.snapshot.value != null) {
            for (final e in _flattenRtdbRecords(snapAtt.data!.snapshot.value)) {
              if (inRange(e)) allPresences.add(e);
            }
          }
          // 'manual_checkins' porte un champ bus_id explicite (format Firestore).
          if (snapManual.data?.snapshot.value != null) {
            for (final e in _flattenRtdbRecords(snapManual.data!.snapshot.value)) {
              if ((e['bus_id'] as String?) != widget.busId) continue;
              if (inRange(e)) allPresences.add(e);
            }
          }

          // Alertes (visage inconnu / température) sur la période, pour ce bus.
          final alertesPeriode = _flattenRtdbRecords(snapAlerts.data?.snapshot.value)
              .where((a) => a['bus_id'] == widget.busId && inRange(a))
              .toList();

          // Clé de tri chronologique : timestamp/created_at si présents,
          // sinon 'date + time' reconstitué (mêmes champs que _dateKeyOf).
          String sortKey(Map<String, dynamic> rec) {
            final ts = (rec['timestamp'] ?? rec['created_at']) as String?;
            if (ts != null && ts.isNotEmpty) return ts;
            final date = rec['date'] as String? ?? '';
            final time = rec['time'] as String? ?? '';
            return '$date $time';
          }
          allPresences.sort((a, b) => sortKey(b).compareTo(sortKey(a)));
          final presents = allPresences;
          final fievresPresences = presents.where((e) => ((e['temperature'] as num?)?.toDouble() ?? 0) > 37.5).length;
          final fievresAlertes = alertesPeriode.where((a) => a['alert_type'] == 'fever').length;
          final fievres = fievresPresences > fievresAlertes ? fievresPresences : fievresAlertes;
          final inconnus = alertesPeriode.where((a) => a['alert_type'] == 'unknown').length;
          final methodCount = <String, int>{};
          for (final e in presents) { final m = _normMethode(e['identification'] as String?); methodCount[m] = (methodCount[m] ?? 0) + 1; }

          return SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Column(children: [
              Row(children: [
                _BigStatCard(label: 'Présents', value: '${presents.length}', icon: Icons.how_to_reg, color: _kBlueMid),
                const SizedBox(width: 10),
                _BigStatCard(label: 'Alertes T°', value: '$fievres', icon: Icons.thermostat, color: fievres > 0 ? Colors.red : Colors.green),
                const SizedBox(width: 10),
                _BigStatCard(label: 'Inconnus', value: '$inconnus', icon: Icons.face_retouching_off, color: inconnus > 0 ? Colors.orange : Colors.grey),
              ]),
              const SizedBox(height: 16),
              // Distance sur la période sélectionnée (Aujourd'hui/Semaine/Mois)
              if (widget.busId.isNotEmpty) ...[
                _DistanceSemaine(busId: widget.busId, periode: _filtre),
                const SizedBox(height: 16),
              ],
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Par méthode de pointage', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  const SizedBox(height: 12),
                  ...['reconnaissance_faciale', 'manuel'].map((m) {
                    final count = methodCount[m] ?? 0;
                    final total = presents.isEmpty ? 1 : presents.length;
                    return Padding(padding: const EdgeInsets.only(bottom: 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Icon(_methodeIcon(m), size: 14, color: _methodeColor(m)), const SizedBox(width: 6),
                        Text(_methodeLabel(m), style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
                        const Spacer(),
                        Text('$count', style: TextStyle(fontWeight: FontWeight.bold, color: _methodeColor(m))),
                      ]),
                      const SizedBox(height: 4),
                      ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(
                        value: count / total, backgroundColor: Colors.grey.shade100,
                        color: _methodeColor(m), minHeight: 6,
                      )),
                    ]));
                  }),
                ]),
              ),
              const SizedBox(height: 16),
              Container(
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14)),
                child: Column(children: [
                  Padding(padding: const EdgeInsets.all(14), child: Row(children: [
                    const Icon(Icons.history, size: 16, color: _kBlueMid), const SizedBox(width: 8),
                    const Text('Historique', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                    const Spacer(),
                    Text('${presents.length} entrées', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                  ])),
                  const Divider(height: 1),
                  if (presents.isEmpty)
                    const Padding(padding: EdgeInsets.all(24), child: Text('Aucun pointage sur cette période', style: TextStyle(color: Colors.grey)))
                  else
                    ...presents.take(20).map((entry) {
                      final tsStr = (entry['timestamp'] ?? entry['created_at']) as String?;
                      DateTime? dt;
                      try {
                        if (tsStr != null) {
                          dt = DateTime.parse(tsStr);
                        } else if (entry['date'] is String) {
                          // Pas de 'timestamp' : reconstitue depuis 'date' (+'time' si dispo),
                          // mêmes champs que ceux utilisés par _dateKeyOf / inRange.
                          final time = (entry['time'] as String?) ?? '00:00:00';
                          dt = DateTime.parse('${entry['date']}T$time');
                        }
                      } catch (_) {}
                      final t = (entry['temperature'] as num?)?.toDouble();
                      final fievre = (t ?? 0) > 37.5;
                      final m = _normMethode(entry['identification'] as String?);
                      final nom = entry['nom'] as String? ?? entry['salarieId'] ?? '';
                      final isInconnu = entry['face_unknown'] == true;
                      final matricule = (entry['matricule'] as String?)?.trim() ?? '';
                      // Photo enrôlée uniquement pour les pointages système (reconnaissance
                      // faciale) identifiés ; le pointage manuel garde l'icône habituelle.
                      final showPhoto = m == 'reconnaissance_faciale' && !isInconnu && matricule.isNotEmpty;
                      return ListTile(
                        dense: true,
                        leading: showPhoto
                            ? _FacePhotoAvatar(matricule: matricule, radius: 14,
                                fallbackIcon: _methodeIcon(m), color: _methodeColor(m))
                            : CircleAvatar(radius: 14,
                                backgroundColor: isInconnu ? Colors.orange.withOpacity(0.15) : _methodeColor(m).withOpacity(0.12),
                                child: Icon(isInconnu ? Icons.face_retouching_off : _methodeIcon(m), size: 13,
                                    color: isInconnu ? Colors.orange : _methodeColor(m))),
                        title: Text(dt != null ? DateFormat('dd/MM · HH:mm:ss').format(dt) : '--', style: const TextStyle(fontSize: 12)),
                        subtitle: Text('$nom · ${_methodeLabel(m)}${isInconnu ? ' · ⚠ Inconnu' : ''}',
                            style: TextStyle(fontSize: 10, color: isInconnu ? Colors.orange : Colors.grey)),
                        trailing: t != null && t > 0
                            ? Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                decoration: BoxDecoration(color: fievre ? Colors.red.shade50 : Colors.green.shade50, borderRadius: BorderRadius.circular(6)),
                                child: Text('${t.toStringAsFixed(1)}°C', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: fievre ? Colors.red : Colors.green)))
                            : null,
                      );
                    }),
                  const SizedBox(height: 16),
                ]),
              ),
              const SizedBox(height: 80),
            ]),
          );
        },
      );
            },
      );
        },
      )),
    ]);
  }

  IconData _methodeIcon(String m) => m == 'reconnaissance_faciale' ? Icons.face : Icons.front_hand;
  Color _methodeColor(String m) => m == 'reconnaissance_faciale' ? Colors.teal : Colors.orange;
  String _methodeLabel(String m) => m == 'reconnaissance_faciale' ? 'Reconnaissance faciale' : 'Manuel';
}

class _BigStatCard extends StatelessWidget {
  final String label, value; final IconData icon; final Color color;
  const _BigStatCard({required this.label, required this.value, required this.icon, required this.color});
  @override Widget build(BuildContext context) => Expanded(child: Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14)),
    child: Column(children: [
      Icon(icon, color: color, size: 20), const SizedBox(height: 4),
      Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: color)),
      Text(label, style: const TextStyle(fontSize: 10, color: Colors.black54), textAlign: TextAlign.center),
    ]),
  ));
}
