// lib/core/router.dart
//
// ⚠️ Version allégée : l'interface admin a été retirée de cette application
// web Flutter. Toute la gestion administrative se fait désormais sur le
// nouveau dashboard React (voir l'URL communiquée par l'équipe). Cette
// application ne conserve plus que l'espace conducteur ("/chauffeur").
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../screens/login_screen.dart';
import '../screens/chauffeur/chauffeur_dashboard.dart';
import '../screens/chauffeur/liste_salaries_screen.dart';
import '../screens/chauffeur/detail_salarie_screen.dart';
import '../screens/chauffeur/choix_bus_circuit_screen.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'root');

final appRouter = GoRouter(
  navigatorKey: rootNavigatorKey,
  initialLocation: '/login',
  debugLogDiagnostics: true,
  redirect: (context, state) {
    final auth = context.read<AuthService>();
    final isLogin = state.matchedLocation == '/login';
    if (auth.isLoading) return null;
    final loggedIn = auth.currentUser != null;

    if (!loggedIn) return isLogin ? null : '/login';

    // Un compte admin n'a plus d'interface ici : on le renvoie au login
    // avec un message (voir login_screen.dart), la gestion admin se faisant
    // désormais exclusivement sur le dashboard web React.
    if (auth.isAdmin) {
      return '/login';
    }

    if (isLogin) {
      if (auth.isConducteur) return '/chauffeur';
      auth.logout();
      return '/login';
    }

    if (state.matchedLocation.startsWith('/chauffeur') && !auth.isConducteur) {
      return '/login';
    }

    // Défense en profondeur : même si quelqu'un tape l'URL directement,
    // seuls les conducteurs privilégiés accèdent à la sélection libre.
    if (state.matchedLocation == '/chauffeur/choix-bus' && !auth.isPrivilegie) {
      return '/chauffeur';
    }
    return null;
  },
  routes: [
    GoRoute(
      path: '/login',
      parentNavigatorKey: rootNavigatorKey,
      builder: (_, __) => const LoginScreen(),
    ),
    GoRoute(
      path: '/chauffeur',
      parentNavigatorKey: rootNavigatorKey,
      builder: (_, __) => const ChauffeurDashboard(),
    ),
    GoRoute(
      path: '/chauffeur/salarie/:id',
      parentNavigatorKey: rootNavigatorKey,
      builder: (context, state) => DetailSalarieScreen(
        salarieId: state.pathParameters['id']!,
      ),
    ),
    GoRoute(
      path: '/chauffeur/choix-bus',
      parentNavigatorKey: rootNavigatorKey,
      builder: (_, __) => const ChoixBusCircuitScreen(),
    ),
  ],
);
