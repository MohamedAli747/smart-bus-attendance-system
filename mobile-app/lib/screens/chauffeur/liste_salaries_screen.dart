// lib/screens/chauffeur/liste_salaries_screen.dart
// Interface chauffeur — salariés Firestore × présences Realtime Database
// RTDB : https://wicmic-71b1e-default-rtdb.europe-west1.firebasedatabase.app/

import 'package:flutter/material.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:provider/provider.dart';
import 'package:go_router/go_router.dart';
import 'package:geolocator/geolocator.dart';
import 'package:intl/intl.dart';
import '../../services/auth_service.dart';

// ── Instance RTDB (région Europe) ─────────────────────────────────────────────
final _rtdb = FirebaseDatabase.instanceFor(
  app: FirebaseDatabase.instance.app,
  databaseURL:
      'https://wicmic-71b1e-default-rtdb.europe-west1.firebasedatabase.app',
);

/// Clé du jour : "2026-05-23"
String get _todayKey {
  final n = DateTime.now();
  return '${n.year}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

// ── Helpers de lecture RTDB (mêmes conventions que le dashboard web React) ──
// 'attendance' peut être imbriqué de façon arbitraire selon comment le
// système de reconnaissance faciale écrit ; on aplatit récursivement pour
// retrouver les enregistrements, identifiés par leur champ 'matricule'.
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

/// Fusionne 'attendance' (auto, clé = matricule) + 'manual_checkins' du jour
/// (clé = salarieId Firestore, converti en matricule) pour le bus donné.
/// Utilisé par toutes les vues de présence de l'écran chauffeur.
Map<String, Map<String, dynamic>> _buildPresenceMapByMatricule({
  required dynamic attendanceRaw,
  required dynamic manualCheckinsRaw,
  required String busId,
  required String todayKey,
}) {
  final map = <String, Map<String, dynamic>>{};

  // 1) attendance (identification automatique) — déjà scopé à ce bus et ce
  //    jour via le chemin RTDB attendance/{immatriculation}/{date}/...
  if (attendanceRaw != null) {
    for (final rec in _flattenRtdbRecords(attendanceRaw)) {
      final mat = (rec['matricule'] ?? rec['employee'])?.toString();
      if (mat == null || mat.isEmpty) continue;
      map[mat] = {...rec, 'identification': rec['identification'] ?? 'face'};
    }
  }

  // 2) manual_checkins/<today> (pointage manuel depuis cette app) — prioritaire
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


// ── Écran liste des salariés ───────────────────────────────────────────────────
class ListeSalariesScreen extends StatefulWidget {
  const ListeSalariesScreen({super.key});
  @override
  State<ListeSalariesScreen> createState() => _ListeSalariesScreenState();
}

class _ListeSalariesScreenState extends State<ListeSalariesScreen> {
  String _recherche = '';
  bool _showPresentsOnly = false;

  Future<void> _annulerPresence(
      BuildContext ctx, String salarieId, String nom) async {
    final ok = await showDialog<bool>(
      context: ctx,
      builder: (_) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Annuler la présence ?'),
        content: Text('Retirer $nom de la liste des présents aujourd\'hui ?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Non')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Retirer'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _rtdb.ref('manual_checkins/$_todayKey/$salarieId').remove();
      if (ctx.mounted) {
        ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
          content: Text('Présence de $nom annulée'),
          backgroundColor: Colors.orange,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (e) {
      if (ctx.mounted) {
        ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
          content: Text('Erreur : $e'),
          backgroundColor: Colors.red,
          behavior: SnackBarBehavior.floating,
        ));
      }
    }
  }

  Future<void> _ouvrirPointage(
    BuildContext ctx,
    String salarieId,
    String nomSalarie,
    String busId,
    bool dejaPresent,
    Map<String, dynamic> salarieData,
  ) async {
    if (dejaPresent) {
      await _annulerPresence(ctx, salarieId, nomSalarie);
      return;
    }
    await showDialog(
      context: ctx,
      barrierDismissible: false,
      builder: (_) => _PointageDialog(
        salarieId: salarieId,
        nomSalarie: nomSalarie,
        busId: busId,
        salarieData: salarieData,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final uid = auth.uid;

    if (auth.isLoading || uid.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    return StreamBuilder<DocumentSnapshot>(
      stream: FirebaseFirestore.instance
          .collection('conducteurs')
          .doc(uid)
          .snapshots(),
      builder: (context, snapCond) {
        final cond = snapCond.data?.data() as Map<String, dynamic>? ?? {};
        final busId = cond['bus_id'] as String? ?? 'N/A';
        final today = DateTime.now();

        // Récupérer le circuit_id depuis le bus du conducteur
        return StreamBuilder<DocumentSnapshot>(
          stream: busId != 'N/A' && busId.isNotEmpty
              ? FirebaseFirestore.instance.collection('buses').doc(busId).snapshots()
              : const Stream.empty(),
          builder: (context, snapBus) {
            final busData = snapBus.data?.data() as Map<String, dynamic>? ?? {};
            final circuitId = busData['circuit_id'] as String? ?? '';
            final busImmatriculation = busData['immatriculation'] as String? ?? '';

            return _buildContent(context, busId, circuitId, today, busImmatriculation);
          },
        );
      },
    );
  }

  Widget _buildContent(BuildContext context, String busId, String circuitId, DateTime today, String busImmatriculation) {
    return Column(children: [
          // ── Bandeau bus + circuit ─────────────────────────────────────────
          Container(
            color: const Color(0xFF0D47A1),
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Row(children: [
              const Icon(Icons.directions_bus, color: Colors.white70, size: 16),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Bus : $busId',
                        style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w600,
                            fontSize: 13)),
                    if (circuitId.isNotEmpty)
                      FutureBuilder<DocumentSnapshot>(
                        future: FirebaseFirestore.instance
                            .collection('circuits')
                            .doc(circuitId)
                            .get(),
                        builder: (ctx, snap) {
                          final d = snap.data?.data() as Map<String, dynamic>? ?? {};
                          final code = d['code'] as String? ?? '';
                          final desig = d['designation'] as String? ?? '';
                          if (code.isEmpty) return const SizedBox.shrink();
                          return Row(children: [
                            const Icon(Icons.route, color: Colors.white54, size: 11),
                            const SizedBox(width: 4),
                            Text('Circuit $code${desig.isNotEmpty ? ' — $desig' : ''}',
                                style: const TextStyle(
                                    color: Colors.white60, fontSize: 11),
                                overflow: TextOverflow.ellipsis),
                          ]);
                        },
                      ),
                  ],
                ),
              ),
              Text(DateFormat('EEEE d MMMM yyyy', 'fr').format(today),
                  style: const TextStyle(color: Colors.white60, fontSize: 11)),
            ]),
          ),

          // ── Filtres ──────────────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
            child: Row(children: [
              // Compteur présents (RTDB temps réel : attendance + manual_checkins)
              StreamBuilder<DatabaseEvent>(
                stream: busImmatriculation.isEmpty ? const Stream<DatabaseEvent>.empty() : _rtdb.ref('attendance/$busImmatriculation/$_todayKey').onValue,
                builder: (ctx, snapAtt) {
                  return StreamBuilder<DatabaseEvent>(
                    stream: _rtdb.ref('manual_checkins/$_todayKey').onValue,
                    builder: (ctx, snapManual) {
                      final presenceMap = _buildPresenceMapByMatricule(
                        attendanceRaw: snapAtt.data?.snapshot.value,
                        manualCheckinsRaw: snapManual.data?.snapshot.value,
                        busId: busId,
                        todayKey: _todayKey,
                      );
                      final count = presenceMap.length;
                      return GestureDetector(
                        onTap: () => setState(
                            () => _showPresentsOnly = !_showPresentsOnly),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 200),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 8),
                          decoration: BoxDecoration(
                            color: _showPresentsOnly
                                ? Colors.green
                                : Colors.green.shade50,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: Colors.green.shade300),
                          ),
                          child: Row(children: [
                            Icon(Icons.check_circle,
                                color: _showPresentsOnly
                                    ? Colors.white
                                    : Colors.green,
                                size: 15),
                            const SizedBox(width: 5),
                            Text('$count présent${count > 1 ? 's' : ''}',
                                style: TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 12,
                                  color: _showPresentsOnly
                                      ? Colors.white
                                      : Colors.green,
                                )),
                          ]),
                        ),
                      );
                    },
                  );
                },
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  decoration: InputDecoration(
                    hintText: 'Nom, matricule...',
                    prefixIcon: const Icon(Icons.search, size: 17),
                    filled: true,
                    fillColor: Colors.grey.shade100,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: BorderSide.none,
                    ),
                    contentPadding: const EdgeInsets.symmetric(vertical: 8),
                    isDense: true,
                  ),
                  onChanged: (v) =>
                      setState(() => _recherche = v.toLowerCase()),
                ),
              ),
            ]),
          ),

          // ── Liste salariés filtrée par circuit (Firestore) × présences (RTDB) ─
          Expanded(
            child: StreamBuilder<QuerySnapshot>(
              stream: circuitId.isNotEmpty
                  ? FirebaseFirestore.instance
                      .collection('salaries')
                      .where('circuit_id', isEqualTo: circuitId)
                      .snapshots()
                  : FirebaseFirestore.instance
                      .collection('salaries')
                      .snapshots(),
              builder: (context, snapSal) {
                if (snapSal.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (!snapSal.hasData || snapSal.data!.docs.isEmpty) {
                  return Center(
                      child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                        const Icon(Icons.people_outline,
                            size: 48, color: Colors.grey),
                        const SizedBox(height: 10),
                        Text(
                          circuitId.isNotEmpty
                              ? 'Aucun salarié dans ce circuit'
                              : 'Aucun salarié',
                          style: const TextStyle(color: Colors.grey),
                        ),
                        if (circuitId.isNotEmpty)
                          const Padding(
                            padding: EdgeInsets.only(top: 6),
                            child: Text(
                              'Les salariés sont filtrés\nselon votre circuit assigné',
                              style: TextStyle(
                                  fontSize: 12, color: Colors.grey),
                              textAlign: TextAlign.center,
                            ),
                          ),
                      ]));
                }

                var salaries = snapSal.data!.docs;
                if (_recherche.isNotEmpty) {
                  salaries = salaries.where((doc) {
                    final d = doc.data() as Map<String, dynamic>;
                    final nom =
                        '${d['prenom'] ?? ''} ${d['nom'] ?? ''}'.toLowerCase();
                    final mat = (d['matricule'] ?? '').toLowerCase();
                    return nom.contains(_recherche) ||
                        mat.contains(_recherche);
                  }).toList();
                }

                return StreamBuilder<DatabaseEvent>(
                  stream: busImmatriculation.isEmpty ? const Stream<DatabaseEvent>.empty() : _rtdb.ref('attendance/$busImmatriculation/$_todayKey').onValue,
                  builder: (context, snapAtt) {
                    return StreamBuilder<DatabaseEvent>(
                      stream: _rtdb.ref('manual_checkins/$_todayKey').onValue,
                      builder: (context, snapManual) {
                        // Fusion attendance (auto) + manual_checkins (manuel),
                        // toutes deux indexées par matricule.
                        final presenceMap = _buildPresenceMapByMatricule(
                          attendanceRaw: snapAtt.data?.snapshot.value,
                          manualCheckinsRaw: snapManual.data?.snapshot.value,
                          busId: busId,
                          todayKey: _todayKey,
                        );

                        String matriculeOf(QueryDocumentSnapshot doc) =>
                            (doc.data() as Map<String, dynamic>)['matricule']
                                    ?.toString() ??
                                '';

                    var filtered = salaries;
                    if (_showPresentsOnly) {
                      filtered = salaries
                          .where((d) => presenceMap.containsKey(matriculeOf(d)))
                          .toList();
                    }

                    // Présents en premier
                    filtered.sort((a, b) {
                      final aP = presenceMap.containsKey(matriculeOf(a));
                      final bP = presenceMap.containsKey(matriculeOf(b));
                      if (aP && !bP) return -1;
                      if (!aP && bP) return 1;
                      return 0;
                    });

                    if (filtered.isEmpty) {
                      return Center(
                        child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(Icons.people_outline,
                                  size: 48, color: Colors.grey),
                              const SizedBox(height: 10),
                              Text(
                                _showPresentsOnly
                                    ? 'Aucun présent pour l\'instant'
                                    : 'Aucun résultat',
                                style: const TextStyle(color: Colors.grey),
                              ),
                            ]),
                      );
                    }

                    return ListView.builder(
                      padding: const EdgeInsets.fromLTRB(12, 4, 12, 80),
                      itemCount: filtered.length,
                      itemBuilder: (context, i) {
                        final d =
                            filtered[i].data() as Map<String, dynamic>;
                        final id = filtered[i].id;
                        final att = presenceMap[(d['matricule'] ?? '').toString()];
                        final isPresent = att != null;
                        final temp =
                            (att?['temperature'] as num?)?.toDouble();
                        final tsStr = att?['timestamp'] as String?;
                        String? heure;
                        if (tsStr != null) {
                          try {
                            heure = DateFormat('HH:mm')
                                .format(DateTime.parse(tsStr));
                          } catch (_) {}
                        }
                        final fievre = (temp ?? 0) > 37.5;
                        final nomComplet =
                            '${d['prenom'] ?? ''} ${d['nom'] ?? ''}'.trim();
                        final methode =
                            att?['identification'] as String? ?? '';

                        return Padding(
                          padding: const EdgeInsets.only(bottom: 7),
                          child: _SalarieCard(
                            salarieId: id,
                            nomComplet: nomComplet,
                            matricule: d['matricule'] ?? '',
                            isPresent: isPresent,
                            methode: methode,
                            temp: temp,
                            heure: heure,
                            fievre: fievre,
                            onTap: () =>
                                context.go('/chauffeur/salarie/$id'),
                            onPointage: () => _ouvrirPointage(
                              context,
                              id,
                              nomComplet,
                              busId,
                              isPresent,
                              d,
                            ),
                          ),
                        );
                      },
                    );
                      },
                    );
                  },
                );
              },
            ),
          ),
        ]);
  }
}

// ── Carte salarié ──────────────────────────────────────────────────────────────
class _SalarieCard extends StatelessWidget {
  final String salarieId, nomComplet, matricule, methode;
  final bool isPresent, fievre;
  final double? temp;
  final String? heure;
  final VoidCallback onTap, onPointage;

  const _SalarieCard({
    required this.salarieId,
    required this.nomComplet,
    required this.matricule,
    required this.isPresent,
    required this.methode,
    required this.temp,
    required this.heure,
    required this.fievre,
    required this.onTap,
    required this.onPointage,
  });

  IconData _methodeIcon() {
    switch (methode) {
      case 'badge_nfc': return Icons.nfc;
      case 'biometrique': return Icons.fingerprint;
      default: return Icons.front_hand;
    }
  }

  Color _methodeColor() {
    switch (methode) {
      case 'badge_nfc': return Colors.blue;
      case 'biometrique': return Colors.purple;
      default: return Colors.orange;
    }
  }

  String _methodeLabel() {
    switch (methode) {
      case 'badge_nfc': return 'Badge NFC';
      case 'biometrique': return 'Biométrique';
      default: return 'Manuel';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: isPresent
                ? (fievre ? Colors.red.shade50 : Colors.green.shade50)
                : Colors.white,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: isPresent
                  ? (fievre ? Colors.red.shade300 : Colors.green.shade300)
                  : Colors.grey.shade200,
              width: isPresent ? 1.5 : 1,
            ),
          ),
          child: Row(children: [
            // Avatar avec indicateur ● présence
            Stack(
              clipBehavior: Clip.none,
              children: [
                CircleAvatar(
                  radius: 22,
                  backgroundColor: isPresent
                      ? (fievre
                          ? Colors.red.shade100
                          : Colors.green.shade100)
                      : const Color(0xFF1565C0).withOpacity(0.1),
                  child: isPresent
                      ? Icon(fievre ? Icons.thermostat : _methodeIcon(),
                          color: fievre ? Colors.red : _methodeColor(),
                          size: 20)
                      : Text(
                          nomComplet.isNotEmpty
                              ? nomComplet[0].toUpperCase()
                              : '?',
                          style: const TextStyle(
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                              color: Color(0xFF1565C0)),
                        ),
                ),
                // ── Indicateur ● (vert = présent, gris = absent) ──
                Positioned(
                  bottom: -2,
                  right: -2,
                  child: Container(
                    width: 13,
                    height: 13,
                    decoration: BoxDecoration(
                      color: isPresent
                          ? (fievre ? Colors.red : Colors.green)
                          : Colors.grey.shade400,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 2),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Expanded(
                        child: Text(nomComplet,
                            style: TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 14,
                                color: isPresent && fievre
                                    ? Colors.red
                                    : Colors.black87)),
                      ),
                      // Badge "PRÉSENT" visible
                      if (isPresent)
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: fievre
                                ? Colors.red.shade100
                                : Colors.green.shade100,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            fievre ? 'FIÈVRE' : 'PRÉSENT',
                            style: TextStyle(
                                fontSize: 9,
                                fontWeight: FontWeight.bold,
                                color: fievre
                                    ? Colors.red
                                    : Colors.green.shade800),
                          ),
                        ),
                    ]),
                    Text('Mat. $matricule',
                        style:
                            TextStyle(fontSize: 11, color: Colors.grey[600])),
                    if (isPresent)
                      Row(children: [
                        Icon(_methodeIcon(),
                            size: 10, color: _methodeColor()),
                        const SizedBox(width: 3),
                        Text(_methodeLabel(),
                            style: TextStyle(
                                fontSize: 10,
                                color: _methodeColor(),
                                fontWeight: FontWeight.w500)),
                        if (fievre) ...[
                          const SizedBox(width: 6),
                          const Text('⚠️ Fièvre',
                              style: TextStyle(
                                  fontSize: 10,
                                  color: Colors.red,
                                  fontWeight: FontWeight.w600)),
                        ],
                      ]),
                  ]),
            ),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              if (isPresent && heure != null)
                Text(heure!,
                    style: TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                        color: fievre ? Colors.red : Colors.green)),
              if (isPresent && temp != null && temp! > 0)
                Container(
                  margin: const EdgeInsets.only(top: 2),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: fievre
                        ? Colors.red.shade100
                        : Colors.green.shade100,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text('${temp!.toStringAsFixed(1)}°C',
                      style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          color: fievre ? Colors.red : Colors.green)),
                ),
              if (!isPresent)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                      color: Colors.grey.shade100,
                      borderRadius: BorderRadius.circular(8)),
                  child: const Text('Absent',
                      style:
                          TextStyle(fontSize: 11, color: Colors.grey)),
                ),
            ]),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: onPointage,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 180),
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: isPresent
                      ? Colors.red.shade50
                      : const Color(0xFF1565C0).withOpacity(0.08),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                      color: isPresent
                          ? Colors.red.shade200
                          : const Color(0xFF1565C0).withOpacity(0.3)),
                ),
                child: Icon(
                  isPresent
                      ? Icons.remove_circle_outline
                      : Icons.how_to_reg_outlined,
                  size: 20,
                  color: isPresent ? Colors.red : const Color(0xFF1565C0),
                ),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

// ── Dialog pointage — écrit dans Realtime Database ────────────────────────────
class _PointageDialog extends StatefulWidget {
  final String salarieId, nomSalarie, busId;
  final Map<String, dynamic> salarieData;

  const _PointageDialog({
    required this.salarieId,
    required this.nomSalarie,
    required this.busId,
    required this.salarieData,
  });

  @override
  State<_PointageDialog> createState() => _PointageDialogState();
}

class _PointageDialogState extends State<_PointageDialog> {
  final _tempCtrl = TextEditingController(text: '36.6');
  String _methode = 'manuel';
  bool _loading = false;
  Position? _position;
  bool _gpsLoading = false;

  @override
  void initState() {
    super.initState();
    _fetchGps();
  }

  Future<void> _fetchGps() async {
    setState(() => _gpsLoading = true);
    try {
      final pos = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
      ).timeout(const Duration(seconds: 8));
      setState(() {
        _position = pos;
        _gpsLoading = false;
      });
    } catch (_) {
      setState(() => _gpsLoading = false);
    }
  }

  Future<void> _enregistrer() async {
    setState(() => _loading = true);
    try {
      final now = DateTime.now();

      final temperature =
          double.tryParse(_tempCtrl.text.replaceAll(',', '.')) ?? 36.6;
      final matricule = widget.salarieData['matricule']?.toString() ?? '';
      final dateStr =
          '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
      final timeStr =
          '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}:${now.second.toString().padLeft(2, '0')}';

      // Écriture dans RTDB : manual_checkins/<date>/<salarieId>
      // ('presences' n'est plus utilisé — remplacé par attendance/manual_checkins/alerts)
      await _rtdb.ref('manual_checkins/$_todayKey/${widget.salarieId}').set({
        'status': 'present',
        'date': dateStr,
        'time': timeStr,
        'timestamp': now.toIso8601String(),
        'temperature': temperature,
        'gps_lat': _position?.latitude ?? 0.0,
        'gps_lng': _position?.longitude ?? 0.0,
        'gps_accuracy': _position?.accuracy ?? 0.0,
        'identification': _methode,
        'bus_id': widget.busId,
        'nom': widget.nomSalarie,
        'matricule': matricule,
      });

      // Si fièvre détectée, on pousse aussi une alerte dans 'alerts'
      // (cohérent avec le reste du système : le dashboard admin lit 'alerts'
      // pour le suivi des températures, qu'elles viennent du pointage
      // automatique ou manuel).
      if (temperature > 37.5) {
        await _rtdb.ref('alerts/$_todayKey').push().set({
          'alert_type': 'fever',
          'date': dateStr,
          'time': timeStr,
          'timestamp': now.toIso8601String(),
          'temperature': temperature,
          'bus_id': widget.busId,
          'nom': widget.nomSalarie,
          'matricule': matricule,
        });
      }

      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('✅ Présence enregistrée'),
          backgroundColor: Colors.green,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (e) {
      setState(() => _loading = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Erreur : $e'),
          backgroundColor: Colors.red,
          behavior: SnackBarBehavior.floating,
        ));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final temp =
        double.tryParse(_tempCtrl.text.replaceAll(',', '.')) ?? 36.6;
    final fievre = temp > 37.5;
    final now = DateTime.now();

    return AlertDialog(
      shape:
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      titlePadding: EdgeInsets.zero,
      title: Container(
        padding: const EdgeInsets.all(20),
        decoration: const BoxDecoration(
          color: Color(0xFF1565C0),
          borderRadius: BorderRadius.only(
              topLeft: Radius.circular(20),
              topRight: Radius.circular(20)),
        ),
        child: Row(children: [
          const Icon(Icons.how_to_reg, color: Colors.white, size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.nomSalarie,
                      style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 15)),
                  Text(
                      'Mat. ${widget.salarieData['matricule'] ?? ''}  ·  Bus: ${widget.busId}',
                      style: const TextStyle(
                          color: Colors.white70, fontSize: 11)),
                ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(DateFormat('HH:mm:ss').format(now),
                style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 16)),
            Text(DateFormat('dd/MM/yyyy').format(now),
                style: const TextStyle(
                    color: Colors.white60, fontSize: 10)),
          ]),
        ]),
      ),
      content: SizedBox(
        width: 340,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 4),
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('Méthode de pointage',
                style: TextStyle(
                    fontWeight: FontWeight.w600, fontSize: 12)),
          ),
          const SizedBox(height: 8),
          Row(children: [
            _MethodeBtn(
                label: 'Manuel',
                icon: Icons.front_hand,
                value: 'manuel',
                selected: _methode == 'manuel',
                color: Colors.orange,
                onTap: () => setState(() => _methode = 'manuel')),
            const SizedBox(width: 8),
            _MethodeBtn(
                label: 'Badge NFC',
                icon: Icons.nfc,
                value: 'badge_nfc',
                selected: _methode == 'badge_nfc',
                color: Colors.blue,
                onTap: () => setState(() => _methode = 'badge_nfc')),
            const SizedBox(width: 8),
            _MethodeBtn(
                label: 'Biométrique',
                icon: Icons.fingerprint,
                value: 'biometrique',
                selected: _methode == 'biometrique',
                color: Colors.purple,
                onTap: () =>
                    setState(() => _methode = 'biometrique')),
          ]),
          const SizedBox(height: 16),
          TextField(
            controller: _tempCtrl,
            keyboardType:
                const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              labelText: 'Température (°C)',
              prefixIcon: Icon(Icons.thermostat,
                  color: fievre ? Colors.red : Colors.orange),
              suffixText: '°C',
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10)),
              filled: true,
              fillColor:
                  fievre ? Colors.red.shade50 : Colors.grey.shade50,
            ),
          ),
          if (fievre) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.red.shade50,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Row(children: [
                Icon(Icons.warning_amber, color: Colors.red, size: 16),
                SizedBox(width: 8),
                Text('⚠️ Température élevée > 37.5°C',
                    style:
                        TextStyle(color: Colors.red, fontSize: 12)),
              ]),
            ),
          ],
          const SizedBox(height: 12),
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.grey.shade50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Colors.grey.shade200),
            ),
            child: Row(children: [
              Icon(
                _position != null
                    ? Icons.gps_fixed
                    : Icons.gps_not_fixed,
                size: 16,
                color: _position != null ? Colors.green : Colors.grey,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _gpsLoading
                    ? const Text('GPS en cours...',
                        style: TextStyle(
                            fontSize: 11, color: Colors.grey))
                    : _position != null
                        ? Text(
                            '${_position!.latitude.toStringAsFixed(5)}, ${_position!.longitude.toStringAsFixed(5)}\nPrécision ±${_position!.accuracy.toStringAsFixed(0)} m',
                            style: const TextStyle(
                                fontSize: 10, color: Colors.green),
                          )
                        : const Text(
                            'GPS non disponible — coordonnées à 0',
                            style: TextStyle(
                                fontSize: 11, color: Colors.grey)),
              ),
              _gpsLoading
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.blue))
                  : GestureDetector(
                      onTap: _fetchGps,
                      child: const Icon(Icons.refresh,
                          size: 16, color: Colors.blue),
                    ),
            ]),
          ),
        ]),
      ),
      actions: [
        TextButton(
            onPressed: _loading ? null : () => Navigator.pop(context),
            child: const Text('Annuler')),
        FilledButton(
          onPressed: _loading ? null : _enregistrer,
          style: FilledButton.styleFrom(
              backgroundColor:
                  fievre ? Colors.red : const Color(0xFF1565C0)),
          child: _loading
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Colors.white))
              : Text(fievre
                  ? 'Enregistrer (fièvre)'
                  : 'Confirmer présence'),
        ),
      ],
    );
  }
}

class _MethodeBtn extends StatelessWidget {
  final String label, value;
  final IconData icon;
  final bool selected;
  final Color color;
  final VoidCallback onTap;

  const _MethodeBtn({
    required this.label,
    required this.icon,
    required this.value,
    required this.selected,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected
                ? color.withOpacity(0.12)
                : Colors.grey.shade50,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: selected ? color : Colors.grey.shade200,
              width: selected ? 2 : 1,
            ),
          ),
          child: Column(children: [
            Icon(icon,
                color: selected ? color : Colors.grey, size: 20),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w600,
                    color: selected ? color : Colors.grey),
                textAlign: TextAlign.center),
          ]),
        ),
      ),
    );
  }
}