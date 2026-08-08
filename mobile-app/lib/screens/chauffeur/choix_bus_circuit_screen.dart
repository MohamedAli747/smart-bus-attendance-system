// lib/screens/chauffeur/choix_bus_circuit_screen.dart
//
// Écran réservé aux conducteurs "privilégiés" (champ `privilegie: true` sur
// leur document Firestore `conducteurs/{id}`). Il leur permet de choisir
// eux-mêmes leur bus et leur circuit, au lieu d'attendre une affectation par
// l'admin (page Assignation du dashboard React).
//
// La logique d'affectation (liaison bidirectionnelle bus <-> conducteur <->
// circuit, avec libération automatique des anciennes affectations) est la
// même que celle utilisée côté admin.

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';

const _kBlue = Color(0xFF1565C0);
const _kBlueDark = Color(0xFF0D47A1);
const _kTeal = Color(0xFF00897B);
const _kBg = Color(0xFFF5F7FB);
const _kOrange = Color(0xFFEF6C00);

class ChoixBusCircuitScreen extends StatefulWidget {
  const ChoixBusCircuitScreen({super.key});

  @override
  State<ChoixBusCircuitScreen> createState() => _ChoixBusCircuitScreenState();
}

class _ChoixBusCircuitScreenState extends State<ChoixBusCircuitScreen> {
  final _db = FirebaseFirestore.instance;

  String? _selectedBusId;
  String? _selectedCircuitId;
  bool _saving = false;
  String? _error;
  String _busSearch = '';
  String _circuitSearch = '';

  Future<void> _logHistorique({
    required String description,
    required Map<String, dynamic> details,
  }) async {
    try {
      await _db.collection('historique').add({
        'action': 'modification',
        'collection': 'assignation',
        'description': description,
        'utilisateur': 'Conducteur (auto-affectation)',
        'timestamp': FieldValue.serverTimestamp(),
        'details': details,
      });
    } catch (_) {
      // L'historique ne doit jamais bloquer l'affectation elle-même.
    }
  }

  Future<void> _confirmer() async {
    final auth = context.read<AuthService>();
    final condId = auth.conducteurDocId;
    if (condId.isEmpty || _selectedBusId == null) return;

    setState(() {
      _saving = true;
      _error = null;
    });

    try {
      final condSnap = await _db.collection('conducteurs').doc(condId).get();
      final ancienBusDuCond = condSnap.data()?['bus_id'] as String? ?? '';

      final busSnap =
          await _db.collection('buses').doc(_selectedBusId).get();
      final ancienCondDuBus = busSnap.data()?['conducteur_id'] as String? ?? '';
      final ancienCircuitDuBus = busSnap.data()?['circuit_id'] as String? ?? '';

      final batch = _db.batch();

      // Libérer l'ancien bus de ce conducteur, si différent du nouveau
      if (ancienBusDuCond.isNotEmpty && ancienBusDuCond != _selectedBusId) {
        batch.update(_db.collection('buses').doc(ancienBusDuCond),
            {'conducteur_id': ''});
      }
      // Libérer l'ancien conducteur du bus choisi, si différent de nous
      if (ancienCondDuBus.isNotEmpty && ancienCondDuBus != condId) {
        batch.update(_db.collection('conducteurs').doc(ancienCondDuBus),
            {'bus_id': ''});
      }

      // Lier bus <-> conducteur
      batch.update(_db.collection('buses').doc(_selectedBusId),
          {'conducteur_id': condId});
      batch.update(_db.collection('conducteurs').doc(condId),
          {'bus_id': _selectedBusId});

      // Circuit (optionnel)
      if (_selectedCircuitId != null) {
        if (ancienCircuitDuBus.isNotEmpty &&
            ancienCircuitDuBus != _selectedCircuitId) {
          batch.update(_db.collection('circuits').doc(ancienCircuitDuBus),
              {'bus_id': ''});
        }
        final circuitSnap =
            await _db.collection('circuits').doc(_selectedCircuitId).get();
        final ancienBusDuCircuit =
            circuitSnap.data()?['bus_id'] as String? ?? '';
        if (ancienBusDuCircuit.isNotEmpty &&
            ancienBusDuCircuit != _selectedBusId) {
          batch.update(_db.collection('buses').doc(ancienBusDuCircuit),
              {'circuit_id': ''});
        }
        batch.update(_db.collection('buses').doc(_selectedBusId),
            {'circuit_id': _selectedCircuitId});
        batch.update(_db.collection('circuits').doc(_selectedCircuitId),
            {'bus_id': _selectedBusId});
      }

      await batch.commit();

      final imm = busSnap.data()?['immatriculation'] ?? _selectedBusId;
      await _logHistorique(
        description: '${auth.nom} (privilégié) s\'est auto-affecté au bus $imm',
        details: {
          'conducteur_id': condId,
          'bus_id': _selectedBusId,
          'circuit_id': _selectedCircuitId ?? '',
        },
      );

      if (mounted) context.go('/chauffeur');
    } catch (e) {
      setState(() => _error = 'Erreur : $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _sectionHeader({required int number, required String title, required Color color}) {
    return Row(
      children: [
        Container(
          width: 24,
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          child: Text('$number',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12)),
        ),
        const SizedBox(width: 10),
        Text(title,
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15.5, color: Color(0xFF1A2027))),
      ],
    );
  }

  Widget _statusChip({required String label, required Color color, IconData icon = Icons.circle}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 11, color: color),
        const SizedBox(width: 4),
        Text(label, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600)),
      ]),
    );
  }

  Widget _emptyState(String message, IconData icon) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 28),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(children: [
        Icon(icon, size: 30, color: Colors.grey.shade400),
        const SizedBox(height: 8),
        Text(message, style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
      ]),
    );
  }

  Widget _selectableTile({
    required bool selected,
    required Color accent,
    required VoidCallback onTap,
    required IconData leadingIcon,
    required String title,
    Widget? subtitle,
    bool enabled = true,
    VoidCallback? onDisabledTap,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Opacity(
        opacity: enabled ? 1 : 0.55,
        child: Material(
          color: selected ? accent.withOpacity(0.06) : Colors.white,
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: enabled ? onTap : onDisabledTap,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: selected ? accent : Colors.grey.shade300, width: selected ? 1.6 : 1),
              ),
              child: Row(children: [
                Container(
                  width: 40,
                  height: 40,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: accent.withOpacity(selected ? 0.16 : 0.08),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    enabled ? leadingIcon : Icons.lock_outline,
                    color: selected ? accent : Colors.grey.shade500,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5)),
                      if (subtitle != null) ...[const SizedBox(height: 4), subtitle],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                if (enabled)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: 22,
                    height: 22,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: selected ? accent : Colors.transparent,
                      border: Border.all(color: selected ? accent : Colors.grey.shade400, width: 1.6),
                    ),
                    child: selected ? const Icon(Icons.check, size: 14, color: Colors.white) : null,
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _searchField({
    required String hint,
    required ValueChanged<String> onChanged,
  }) {
    return TextField(
      onChanged: onChanged,
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(fontSize: 13, color: Colors.grey.shade500),
        prefixIcon: Icon(Icons.search, size: 19, color: Colors.grey.shade500),
        filled: true,
        fillColor: Colors.white,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: Colors.grey.shade300),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: Colors.grey.shade300),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _kBlue, width: 1.6),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final condId = auth.conducteurDocId;

    return Scaffold(
      backgroundColor: _kBg,
      appBar: AppBar(
        elevation: 0,
        centerTitle: false,
        backgroundColor: _kBlue,
        foregroundColor: Colors.white,
        title: const Text('Choisir mon bus et mon circuit',
            style: TextStyle(fontWeight: FontWeight.w600, fontSize: 17)),
        flexibleSpace: Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [_kBlue, _kBlueDark],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
        ),
      ),
      body: condId.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : StreamBuilder<DocumentSnapshot>(
              stream: _db.collection('conducteurs').doc(condId).snapshots(),
              builder: (context, snapCond) {
                final condData = snapCond.data?.data() as Map<String, dynamic>? ?? {};
                final busActuel = condData['bus_id'] as String? ?? '';
                _selectedBusId ??= busActuel.isNotEmpty ? busActuel : null;

                return SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 100),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: [_kBlue.withOpacity(0.08), _kTeal.withOpacity(0.06)],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: _kBlue.withOpacity(0.18)),
                        ),
                        child: Row(children: [
                          Container(
                            width: 32,
                            height: 32,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(color: _kBlue.withOpacity(0.14), shape: BoxShape.circle),
                            child: const Icon(Icons.info_outline, color: _kBlue, size: 18),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              'En tant que conducteur privilégié, vous pouvez choisir vous-même votre bus et votre circuit. Vous pourrez les changer à tout moment ici.',
                              style: TextStyle(fontSize: 12.5, color: Colors.grey.shade800, height: 1.4),
                            ),
                          ),
                        ]),
                      ),
                      const SizedBox(height: 24),
                      StreamBuilder<QuerySnapshot>(
                        stream: _db.collection('buses').orderBy('immatriculation').snapshots(),
                        builder: (context, snap) {
                          if (!snap.hasData) {
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _sectionHeader(number: 1, title: 'Choisir un bus', color: _kBlue),
                                const Padding(
                                  padding: EdgeInsets.symmetric(vertical: 20),
                                  child: Center(child: CircularProgressIndicator()),
                                ),
                              ],
                            );
                          }
                          final allDocs = snap.data!.docs;
                          if (allDocs.isEmpty) {
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _sectionHeader(number: 1, title: 'Choisir un bus', color: _kBlue),
                                const SizedBox(height: 12),
                                _emptyState('Aucun bus disponible.', Icons.directions_bus_outlined),
                              ],
                            );
                          }

                          final q = _busSearch.trim().toLowerCase();
                          final docs = q.isEmpty
                              ? allDocs
                              : allDocs.where((d) {
                                  final data = d.data() as Map<String, dynamic>;
                                  final imm = (data['immatriculation']?.toString() ?? '').toLowerCase();
                                  final marque = (data['marque']?.toString() ?? '').toLowerCase();
                                  return imm.contains(q) || marque.contains(q);
                                }).toList();

                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  _sectionHeader(number: 1, title: 'Choisir un bus', color: _kBlue),
                                  const Spacer(),
                                  Text('${allDocs.length} bus',
                                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600, fontWeight: FontWeight.w600)),
                                ],
                              ),
                              const SizedBox(height: 10),
                              if (allDocs.length > 4) ...[
                                _searchField(
                                  hint: 'Rechercher une immatriculation, une marque...',
                                  onChanged: (v) => setState(() => _busSearch = v),
                                ),
                                const SizedBox(height: 12),
                              ],
                              if (docs.isEmpty)
                                _emptyState('Aucun bus ne correspond à "$_busSearch".', Icons.search_off_rounded)
                              else
                                ...docs.map((d) {
                                  final data = d.data() as Map<String, dynamic>;
                                  final busId = d.id;
                                  final autreConducteur = (data['conducteur_id'] as String? ?? '');
                                  final estPrisParAutre = autreConducteur.isNotEmpty && autreConducteur != condId;
                                  final estMienActuellement = busId == busActuel && busActuel.isNotEmpty;
                                  final selected = _selectedBusId == busId;
                                  final marque = (data['marque'] as String?) ?? '';

                                  return _selectableTile(
                                    selected: selected,
                                    accent: _kBlue,
                                    leadingIcon: Icons.directions_bus_filled_rounded,
                                    enabled: !estPrisParAutre,
                                    onTap: () => setState(() {
                                      _selectedBusId = busId;
                                      // Un bus déjà associé à un autre circuit reste
                                      // sélectionnable indépendamment ; on ne réinitialise
                                      // le circuit que si l'utilisateur en avait choisi un
                                      // manuellement incompatible — laissé à son choix.
                                    }),
                                    onDisabledTap: () {
                                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                                        content: Text('Ce bus est déjà affecté à un autre conducteur.'),
                                        backgroundColor: _kOrange,
                                        behavior: SnackBarBehavior.floating,
                                      ));
                                    },
                                    title: data['immatriculation']?.toString() ?? busId,
                                    subtitle: Wrap(
                                      spacing: 6,
                                      runSpacing: 4,
                                      crossAxisAlignment: WrapCrossAlignment.center,
                                      children: [
                                        if (marque.isNotEmpty)
                                          Text(marque, style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                                        if (estMienActuellement)
                                          _statusChip(label: 'Votre bus actuel', color: _kTeal, icon: Icons.check_circle),
                                        if (estPrisParAutre)
                                          _statusChip(label: 'Déjà affecté', color: _kOrange, icon: Icons.lock_outline),
                                      ],
                                    ),
                                  );
                                }),
                            ],
                          );
                        },
                      ),
                      const SizedBox(height: 24),
                      StreamBuilder<QuerySnapshot>(
                        stream: _db.collection('circuits').orderBy('code').snapshots(),
                        builder: (context, snap) {
                          if (!snap.hasData) {
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _sectionHeader(number: 2, title: 'Choisir un circuit (optionnel)', color: _kTeal),
                                const Padding(
                                  padding: EdgeInsets.symmetric(vertical: 20),
                                  child: Center(child: CircularProgressIndicator()),
                                ),
                              ],
                            );
                          }
                          final allDocs = snap.data!.docs;
                          if (allDocs.isEmpty) {
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _sectionHeader(number: 2, title: 'Choisir un circuit (optionnel)', color: _kTeal),
                                const SizedBox(height: 12),
                                _emptyState('Aucun circuit disponible.', Icons.alt_route_outlined),
                              ],
                            );
                          }

                          final q = _circuitSearch.trim().toLowerCase();
                          final docs = q.isEmpty
                              ? allDocs
                              : allDocs.where((d) {
                                  final data = d.data() as Map<String, dynamic>;
                                  final code = (data['code']?.toString() ?? '').toLowerCase();
                                  final desig = (data['designation']?.toString() ?? '').toLowerCase();
                                  return code.contains(q) || desig.contains(q);
                                }).toList();

                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  _sectionHeader(number: 2, title: 'Choisir un circuit (optionnel)', color: _kTeal),
                                  const Spacer(),
                                  Text('${allDocs.length} circuits',
                                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600, fontWeight: FontWeight.w600)),
                                ],
                              ),
                              const SizedBox(height: 10),
                              if (allDocs.length > 4) ...[
                                _searchField(
                                  hint: 'Rechercher un code, une désignation...',
                                  onChanged: (v) => setState(() => _circuitSearch = v),
                                ),
                                const SizedBox(height: 12),
                              ],
                              if (docs.isEmpty)
                                _emptyState('Aucun circuit ne correspond à "$_circuitSearch".', Icons.search_off_rounded)
                              else
                                ...docs.map((d) {
                                  final data = d.data() as Map<String, dynamic>;
                                  final circuitId = d.id;
                                  final busQuiUtilise = (data['bus_id'] as String? ?? '');
                                  final prisParAutreBus = busQuiUtilise.isNotEmpty && busQuiUtilise != _selectedBusId;
                                  final selected = _selectedCircuitId == circuitId;

                                  return _selectableTile(
                                    selected: selected,
                                    accent: _kTeal,
                                    leadingIcon: Icons.alt_route_rounded,
                                    enabled: !prisParAutreBus,
                                    onTap: () => setState(
                                        () => _selectedCircuitId = circuitId == _selectedCircuitId ? null : circuitId),
                                    onDisabledTap: () {
                                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                                        content: Text('Ce circuit est déjà utilisé par un autre bus.'),
                                        backgroundColor: _kOrange,
                                        behavior: SnackBarBehavior.floating,
                                      ));
                                    },
                                    title: '${data['code'] ?? circuitId} — ${data['designation'] ?? ''}',
                                    subtitle: prisParAutreBus
                                        ? _statusChip(label: 'Déjà utilisé par un autre bus', color: _kOrange, icon: Icons.lock_outline)
                                        : null,
                                  );
                                }),
                            ],
                          );
                        },
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 16),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.red.withOpacity(0.06),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: Colors.red.withOpacity(0.25)),
                          ),
                          child: Row(children: [
                            const Icon(Icons.error_outline, color: Colors.red, size: 18),
                            const SizedBox(width: 8),
                            Expanded(child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 13))),
                          ]),
                        ),
                      ],
                    ],
                  ),
                );
              },
            ),
      bottomNavigationBar: SafeArea(
        minimum: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Container(
          decoration: BoxDecoration(
            boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 16, offset: const Offset(0, -4))],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_selectedBusId != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: StreamBuilder<DocumentSnapshot>(
                    stream: _db.collection('buses').doc(_selectedBusId).snapshots(),
                    builder: (context, snapBus) {
                      final busData = snapBus.data?.data() as Map<String, dynamic>? ?? {};
                      final imm = busData['immatriculation']?.toString() ?? '';
                      return StreamBuilder<DocumentSnapshot>(
                        stream: _selectedCircuitId != null
                            ? _db.collection('circuits').doc(_selectedCircuitId).snapshots()
                            : const Stream.empty(),
                        builder: (context, snapCirc) {
                          final circData = snapCirc.data?.data() as Map<String, dynamic>? ?? {};
                          final code = circData['code']?.toString();
                          return Wrap(
                            spacing: 8,
                            runSpacing: 6,
                            children: [
                              _statusChip(label: imm.isNotEmpty ? 'Bus $imm' : 'Bus sélectionné', color: _kBlue, icon: Icons.directions_bus_filled_rounded),
                              if (code != null && code.isNotEmpty)
                                _statusChip(label: 'Circuit $code', color: _kTeal, icon: Icons.alt_route_rounded),
                            ],
                          );
                        },
                      );
                    },
                  ),
                ),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: (_selectedBusId == null || _saving) ? null : _confirmer,
                  icon: _saving
                      ? const SizedBox(
                          width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        )
                      : const Icon(Icons.check_circle),
                  label: Text(_saving ? 'Enregistrement…' : 'Valider mon affectation',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: _kBlue,
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: Colors.grey.shade300,
                    elevation: 0,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
