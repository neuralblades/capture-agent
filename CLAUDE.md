# Capture Agent - AO Workspace Rules

## Core Rules
- Work ONLY inside your designated folder.
- Follow Manifest V3 guidelines (no unsafe-eval, use Service Workers).
- Export typed JSON contracts for inter-module communication.

## Module Ownership
- Session 1 (Extension Core): `/extension/content/` & `manifest.json`
- Session 2 (Dashboard UI): `/extension/sidepanel/`
- Session 3 (AI Backend): `/backend/`
- Session 4 (JARVIS Actions): `/extension/actions/`
