// lib/screens/chauffeur/detail_salarie_screen.dart
import 'package:flutter/material.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

// ── Instance RTDB (région Europe) ─────────────────────────────────────────────
final _rtdb = FirebaseDatabase.instanceFor(
  app: FirebaseDatabase.instance.app,
  databaseURL:
      'https://wicmic-71b1e-default-rtdb.europe-west1.firebasedatabase.app',
);

/// Clé du jour : "2026-05-23" (mêmes conventions que liste_salaries_screen).
String get _todayKey {
  final n = DateTime.now();
  return '${n.year}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

/// Date ISO ("yyyy-MM-dd") d'un enregistrement de présence, en se basant sur
/// le champ 'date' s'il existe, sinon sur 'timestamp'/'created_at'.
String _dateKeyOf(Map<String, dynamic> rec) {
  if (rec['date'] is String && (rec['date'] as String).isNotEmpty) {
    return rec['date'] as String;
  }
  final raw = rec['timestamp'] ?? rec['created_at'];
  if (raw is String) {
    try {
      final d = DateTime.parse(raw);
      return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
    } catch (_) {}
  }
  return '';
}

// ── Helpers de lecture RTDB (identiques aux autres écrans chauffeur) ──
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

/// Combine attendance (auto) + manual_checkins pour un matricule donné,
/// triés du plus récent au plus ancien, limités aux [limit] derniers.
List<Map<String, dynamic>> _presencesForMatricule({
  required dynamic attendanceRaw,
  required dynamic manualCheckinsRaw,
  required String matricule,
  int limit = 15,
}) {
  final all = <Map<String, dynamic>>[];
  if (attendanceRaw != null) {
    for (final rec in _flattenRtdbRecords(attendanceRaw)) {
      final mat = (rec['matricule'] ?? rec['employee'])?.toString();
      if (mat == matricule) all.add(rec);
    }
  }
  if (manualCheckinsRaw != null) {
    for (final rec in _flattenRtdbRecords(manualCheckinsRaw)) {
      final mat = rec['matricule']?.toString();
      if (mat == matricule) all.add(rec);
    }
  }
  all.sort((a, b) {
    final ta = (a['timestamp'] ?? a['created_at'])?.toString() ?? '';
    final tb = (b['timestamp'] ?? b['created_at'])?.toString() ?? '';
    return tb.compareTo(ta);
  });
  return all.take(limit).toList();
}

class DetailSalarieScreen extends StatelessWidget {
  final String salarieId;
  const DetailSalarieScreen({super.key, required this.salarieId});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Color(0xFF1A2027)),
          tooltip: 'Retour',
          onPressed: () {
            // context.go() remplace la pile de navigation (pas de push), donc
            // AppBar n'affiche pas de flèche retour automatique. On revient
            // explicitement à la liste des salariés.
            if (context.canPop()) {
              context.pop();
            } else {
              context.go('/chauffeur');
            }
          },
        ),
        title: const Text('Fiche salarié',
            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        bottom: const PreferredSize(
            preferredSize: Size.fromHeight(1),
            child: Divider(height: 1)),
      ),
      body: FutureBuilder<DocumentSnapshot>(
        future: FirebaseFirestore.instance
            .collection('salaries')
            .doc(salarieId)
            .get(),
        builder: (context, snapSal) {
          if (!snapSal.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final d =
              snapSal.data!.data() as Map<String, dynamic>? ?? {};
          final nomComplet =
              '${d['prenom'] ?? ''} ${d['nom'] ?? ''}'.trim();

          final matricule = (d['matricule'] ?? '').toString();

          return StreamBuilder<DatabaseEvent>(
            stream: _rtdb.ref('attendance').onValue,
            builder: (context, snapAttRtdb) {
              return StreamBuilder<DatabaseEvent>(
                stream: _rtdb.ref('manual_checkins').onValue,
                builder: (context, snapManual) {
              final attDocs = _presencesForMatricule(
                attendanceRaw: snapAttRtdb.data?.snapshot.value,
                manualCheckinsRaw: snapManual.data?.snapshot.value,
                matricule: matricule,
              );
              // BUGFIX : le statut "Présent" affiché en haut de fiche ne doit
              // refléter que la présence du jour même — pas tout l'historique.
              // Avant ce correctif, un salarié pointé une seule fois restait
              // marqué "Présent" indéfiniment (ex. Lobna Hajji).
              final presencesAujourdhui =
                  attDocs.where((r) => _dateKeyOf(r) == _todayKey).toList();
              final derniere =
                  presencesAujourdhui.isNotEmpty ? presencesAujourdhui.first : null;
              final isPresent = derniere != null;
              final temp =
                  (derniere?['temperature'] as num?)?.toDouble();
              final fievre = temp != null && temp > 37.5;

              return SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [

                    // ── Profil ─────────────────────────
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border:
                            Border.all(color: Colors.grey.shade200),
                      ),
                      child: Row(children: [
                        CircleAvatar(
                          radius: 32,
                          backgroundColor: const Color(0xFF1565C0)
                              .withValues(alpha: 0.1),
                          child: Text(
                            nomComplet.isNotEmpty
                                ? nomComplet[0].toUpperCase()
                                : '?',
                            style: const TextStyle(
                                fontSize: 24,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF1565C0)),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment:
                                CrossAxisAlignment.start,
                            children: [
                              Text(nomComplet,
                                  style: const TextStyle(
                                      fontSize: 17,
                                      fontWeight: FontWeight.bold)),
                              const SizedBox(height: 4),
                              _Row(
                                  icon: Icons.badge_outlined,
                                  text:
                                      'Mat. ${d['matricule'] ?? ''}'),
                              _Row(
                                  icon: Icons.route_outlined,
                                  text:
                                      'Circuit ${d['circuit_id'] ?? ''}'),
                            ],
                          ),
                        ),
                        // Statut
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 10),
                          decoration: BoxDecoration(
                            color: isPresent
                                ? Colors.green.shade50
                                : Colors.grey.shade100,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(
                                color: isPresent
                                    ? Colors.green.shade200
                                    : Colors.grey.shade300),
                          ),
                          child: Column(children: [
                            Icon(
                              isPresent
                                  ? Icons.check_circle
                                  : Icons.cancel_outlined,
                              color: isPresent
                                  ? Colors.green
                                  : Colors.grey,
                              size: 26,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              isPresent ? 'Présent' : 'Absent',
                              style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: isPresent
                                      ? Colors.green
                                      : Colors.grey),
                            ),
                          ]),
                        ),
                      ]),
                    ),

                    // ── Alertes fièvre ──────────────────
                    if (fievre) ...[
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.red.shade50,
                          borderRadius: BorderRadius.circular(12),
                          border:
                              Border.all(color: Colors.red.shade200),
                        ),
                        child: Row(children: [
                          const Icon(Icons.warning_amber,
                              color: Colors.red),
                          const SizedBox(width: 10),
                          Column(
                              crossAxisAlignment:
                                  CrossAxisAlignment.start,
                              children: [
                            const Text('⚠️ Température élevée',
                                style: TextStyle(
                                    fontWeight: FontWeight.bold,
                                    color: Colors.red)),
                            Text(
                              '${temp.toStringAsFixed(1)} °C — supérieure à 37,5°C',
                              style: const TextStyle(
                                  color: Colors.red, fontSize: 13),
                            ),
                          ]),
                        ]),
                      ),
                    ],

                    // ── Dernière présence ───────────────
                    if (derniere != null) ...[
                      const SizedBox(height: 20),
                      const Text('Dernière présence',
                          style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.bold)),
                      const SizedBox(height: 10),
                      Row(children: [
                        _MiniCard(
                          icon: Icons.access_time,
                          label: 'Heure',
                          value: derniere['timestamp'] is String
                              ? DateFormat('HH:mm').format(
                                  DateTime.parse(
                                      derniere['timestamp'] as String))
                              : '--',
                          color: Colors.blue,
                        ),
                        const SizedBox(width: 10),
                        _MiniCard(
                          icon: Icons.thermostat,
                          label: 'Température',
                          value: temp != null && temp > 0
                              ? '${temp.toStringAsFixed(1)} °C'
                              : '--',
                          color: fievre ? Colors.red : Colors.green,
                        ),
                        const SizedBox(width: 10),
                        _MiniCard(
                          icon: derniere['identification'] == 'manuel'
                              ? Icons.front_hand
                              : Icons.face,
                          label: 'Via',
                          value: derniere['identification'] == 'manuel'
                              ? 'Manuel'
                              : derniere['identification'] == 'face'
                                  ? 'Visage'
                                  : 'Empreinte',
                          color:
                              derniere['identification'] == 'manuel'
                                  ? Colors.orange
                                  : Colors.purple,
                        ),
                        const SizedBox(width: 10),
                        _MiniCard(
                          icon: Icons.directions_bus,
                          label: 'Bus',
                          value: derniere['bus_id'] ?? '--',
                          color: Colors.teal,
                        ),
                      ]),
                    ],

                    // ── Historique ──────────────────────
                    const SizedBox(height: 24),
                    const Text('Historique (15 derniers)',
                        style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.bold)),
                    const SizedBox(height: 10),

                    attDocs.isEmpty
                        ? Container(
                            padding: const EdgeInsets.all(30),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                  color: Colors.grey.shade200),
                            ),
                            child: const Center(
                              child: Text(
                                  'Aucune présence enregistrée',
                                  style:
                                      TextStyle(color: Colors.grey)),
                            ),
                          )
                        : Container(
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                  color: Colors.grey.shade200),
                            ),
                            child: ListView.separated(
                              shrinkWrap: true,
                              physics:
                                  const NeverScrollableScrollPhysics(),
                              itemCount: attDocs.length,
                              separatorBuilder: (_, __) =>
                                  const Divider(height: 1, indent: 16),
                              itemBuilder: (ctx, i) {
                                final att = attDocs[i];
                                final ts = att['timestamp'] is String
                                    ? DateTime.tryParse(
                                        att['timestamp'] as String)
                                    : null;
                                final t =
                                    (att['temperature'] as num?)
                                        ?.toDouble();
                                final isManuel =
                                    att['identification'] == 'manuel';

                                return ListTile(
                                  dense: true,
                                  leading: CircleAvatar(
                                    radius: 14,
                                    backgroundColor: Colors.green.shade50,
                                    child: Icon(
                                      isManuel
                                          ? Icons.front_hand
                                          : Icons.check,
                                      size: 13,
                                      color: isManuel
                                          ? Colors.orange
                                          : Colors.green,
                                    ),
                                  ),
                                  title: Text(
                                    ts != null
                                        ? DateFormat('dd/MM/yyyy HH:mm')
                                            .format(ts)
                                        : '--',
                                    style:
                                        const TextStyle(fontSize: 13),
                                  ),
                                  subtitle: Text(
                                    '${isManuel ? '✋ Manuel' : att['identification'] ?? ''} · Bus: ${att['bus_id'] ?? ''}',
                                    style:
                                        const TextStyle(fontSize: 11),
                                  ),
                                  trailing: t != null && t > 0
                                      ? Container(
                                          padding:
                                              const EdgeInsets.symmetric(
                                                  horizontal: 8,
                                                  vertical: 3),
                                          decoration: BoxDecoration(
                                            color: (t > 37.5)
                                                ? Colors.red.shade50
                                                : Colors.green.shade50,
                                            borderRadius:
                                                BorderRadius.circular(
                                                    6),
                                          ),
                                          child: Text(
                                            '${t.toStringAsFixed(1)} °C',
                                            style: TextStyle(
                                                fontSize: 11,
                                                fontWeight:
                                                    FontWeight.w600,
                                                color: (t > 37.5)
                                                    ? Colors.red
                                                    : Colors.green),
                                          ),
                                        )
                                      : null,
                                );
                              },
                            ),
                          ),
                  ],
                ),
              );
            },
          );
        },
      );
        },
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final IconData icon;
  final String text;
  const _Row({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: Row(children: [
        Icon(icon, size: 13, color: Colors.grey),
        const SizedBox(width: 5),
        Text(text,
            style: TextStyle(fontSize: 12, color: Colors.grey[700])),
      ]),
    );
  }
}

class _MiniCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;
  const _MiniCard(
      {required this.icon,
      required this.label,
      required this.value,
      required this.color});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.grey.shade200),
        ),
        child: Column(children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 6),
          Text(value,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  color: color),
              textAlign: TextAlign.center),
          Text(label,
              style: TextStyle(
                  fontSize: 10, color: Colors.grey[600])),
        ]),
      ),
    );
  }
}
