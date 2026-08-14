// lib/screens/login_screen.dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:go_router/go_router.dart';
import '../services/auth_service.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailCtrl = TextEditingController();
  final _passCtrl  = TextEditingController();
  final _formKey   = GlobalKey<FormState>();
  bool _loading = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() { _emailCtrl.dispose(); _passCtrl.dispose(); super.dispose(); }

  Future<void> _login({required bool viaPrivilege}) async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { _loading = true; _error = null; });

    final auth = context.read<AuthService>();

    // ✅ loginAndWaitRole attend que le rôle soit chargé AVANT de naviguer
    final err = await auth.loginAndWaitRole(_emailCtrl.text, _passCtrl.text);

    if (!mounted) return;

    if (err != null) {
      setState(() { _error = err; _loading = false; });
    } else {
      // Le rôle est maintenant garanti d'être chargé
      if (auth.isAdmin) {
        // L'interface admin a été retirée de cette application web : la
        // gestion se fait désormais sur le dashboard React.
        await auth.logout();
        setState(() {
          _error = "Accès admin indisponible ici. Utilisez le dashboard web (React).";
          _loading = false;
        });
      } else if (auth.isConducteur) {
        if (viaPrivilege) {
          if (auth.isPrivilegie) {
            // Seuls les conducteurs marqués "privilegie: true" par l'admin
            // (Firestore conducteurs/{id}) peuvent choisir eux-mêmes leur
            // bus et circuit (écrit dans buses/conducteurs/circuits +
            // historique, exactement comme la page Assignation admin).
            context.go('/chauffeur/choix-bus');
          } else {
            // Compte non autorisé pour la connexion privilège : on le
            // déconnecte et on l'informe, plutôt que de le laisser
            // accéder à l'écran de sélection.
            await auth.logout();
            setState(() {
              _error =
                  "Ce compte n'a pas l'accès privilège. Utilisez \"Se connecter\" pour voir votre affectation actuelle.";
              _loading = false;
            });
          }
        } else {
          context.go('/chauffeur');
        }
      } else {
        await auth.logout();
        setState(() {
          _error = 'Accès refusé. Compte non autorisé.';
          _loading = false;
        });
      }
    }
  }

  Future<void> _showForgotPasswordDialog(BuildContext context) async {
    final resetEmailCtrl = TextEditingController(text: _emailCtrl.text);
    final resetFormKey = GlobalKey<FormState>();
    bool sending = false;
    String? resetError;
    String? resetSuccess;

    final auth = context.read<AuthService>();

    await showDialog<void>(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (dialogCtx, setDialogState) {
            return AlertDialog(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              title: const Text('Mot de passe oublié'),
              content: Form(
                key: resetFormKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Saisissez votre adresse e-mail. Un lien de réinitialisation vous sera envoyé.',
                      style: TextStyle(fontSize: 13),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: resetEmailCtrl,
                      keyboardType: TextInputType.emailAddress,
                      decoration: const InputDecoration(
                        labelText: 'Adresse email',
                        prefixIcon: Icon(Icons.email_outlined),
                      ),
                      validator: (v) {
                        if (v == null || v.isEmpty) return 'Email requis';
                        if (!v.contains('@')) return 'Email invalide';
                        return null;
                      },
                    ),
                    if (resetError != null) ...[
                      const SizedBox(height: 10),
                      Text(resetError!, style: const TextStyle(color: Colors.red, fontSize: 13)),
                    ],
                    if (resetSuccess != null) ...[
                      const SizedBox(height: 10),
                      Text(resetSuccess!, style: const TextStyle(color: Colors.green, fontSize: 13)),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: sending ? null : () => Navigator.pop(dialogCtx),
                  child: const Text('Fermer'),
                ),
                FilledButton(
                  onPressed: sending
                      ? null
                      : () async {
                          if (!resetFormKey.currentState!.validate()) return;
                          setDialogState(() {
                            sending = true;
                            resetError = null;
                            resetSuccess = null;
                          });
                          final err = await auth.sendPasswordResetEmail(resetEmailCtrl.text);
                          setDialogState(() {
                            sending = false;
                            if (err != null) {
                              resetError = err;
                            } else {
                              resetSuccess = 'E-mail envoyé. Vérifiez votre boîte de réception.';
                            }
                          });
                        },
                  child: sending
                      ? const SizedBox(
                          width: 18, height: 18,
                          child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                        )
                      : const Text('Envoyer'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF1565C0),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Card(
              elevation: 0,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              child: Padding(
                padding: const EdgeInsets.all(36),
                child: Form(
                  key: _formKey,
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                      width: 80, height: 80,
                      decoration: BoxDecoration(
                        color: const Color(0xFF1565C0),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: const Icon(Icons.directions_bus_rounded,
                          color: Colors.white, size: 40),
                    ),
                    const SizedBox(height: 20),
                    Text('WICMIC Transport',
                        style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                            color: const Color(0xFF1565C0))),
                    const SizedBox(height: 4),
                    Text('Gestion du transport industriel',
                        style: TextStyle(color: Colors.grey[500], fontSize: 13)),
                    const SizedBox(height: 36),
                    TextFormField(
                      controller: _emailCtrl,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Adresse email',
                        prefixIcon: Icon(Icons.email_outlined),
                      ),
                      validator: (v) {
                        if (v == null || v.isEmpty) return 'Email requis';
                        if (!v.contains('@')) return 'Email invalide';
                        return null;
                      },
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _passCtrl,
                      obscureText: _obscure,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _login(viaPrivilege: false),
                      decoration: InputDecoration(
                        labelText: 'Mot de passe',
                        prefixIcon: const Icon(Icons.lock_outlined),
                        suffixIcon: IconButton(
                          icon: Icon(_obscure
                              ? Icons.visibility_off_outlined
                              : Icons.visibility_outlined),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      validator: (v) =>
                          (v == null || v.isEmpty) ? 'Mot de passe requis' : null,
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 14),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                        decoration: BoxDecoration(
                          color: Colors.red[50],
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: Colors.red.shade200),
                        ),
                        child: Row(children: [
                          const Icon(Icons.error_outline, color: Colors.red, size: 18),
                          const SizedBox(width: 8),
                          Expanded(child: Text(_error!,
                              style: const TextStyle(color: Colors.red, fontSize: 13))),
                        ]),
                      ),
                    ],
                    const SizedBox(height: 28),
                    SizedBox(
                      width: double.infinity, height: 50,
                      child: FilledButton(
                        onPressed: _loading ? null : () => _login(viaPrivilege: false),
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF1565C0),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                        ),
                        child: _loading
                            ? const SizedBox(width: 22, height: 22,
                                child: CircularProgressIndicator(
                                    color: Colors.white, strokeWidth: 2.5))
                            : const Text('Se connecter',
                                style: TextStyle(fontSize: 16)),
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity, height: 50,
                      child: OutlinedButton.icon(
                        onPressed: _loading ? null : () => _login(viaPrivilege: true),
                        icon: const Icon(Icons.touch_app, size: 18),
                        label: const Text('Connexion privilège',
                            style: TextStyle(fontSize: 15)),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF1565C0),
                          side: const BorderSide(color: Color(0xFF1565C0)),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                        ),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text('Connexion privilège : choisissez vous-même votre bus et votre circuit après connexion.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 10.5, color: Colors.grey[500])),
                    const SizedBox(height: 12),
                    TextButton(
                      onPressed: _loading ? null : () => _showForgotPasswordDialog(context),
                      child: const Text('Mot de passe oublié ?',
                          style: TextStyle(fontSize: 13)),
                    ),
                    const SizedBox(height: 4),
                    Text('© WICMIC Group — Système de transport',
                        style: TextStyle(fontSize: 11, color: Colors.grey[400])),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}