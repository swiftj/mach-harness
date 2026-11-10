---
name: init
description: Sets up the MACH factory files in the current project (.factory/, REVIEW.md, AGENTS.md, make targets, a MACH section in CLAUDE.md) without overwriting anything that exists. Use when the user asks to set up, initialize, or scaffold MACH in a project.
disable-model-invocation: true
argument-hint: "[--dry-run]"
---

# MACH Init

Set up the MACH factory files in this project. A script does all of it; do not create the files yourself.

1. Run, from the project root:

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/bin/mach" scaffold --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS
   ```

2. Show the user what it printed: which files were created, which were kept because they already existed, and any that were skipped.
3. If it skipped files, explain that those files were changed since MACH installed them, and that running the command again with `--force` replaces them after saving a backup. Do not add `--force` yourself.
4. Tell the user they can now groom their first ticket with `/mach:intent <feature idea>`, and that `python3 .factory/bin/mach uninstall` removes the factory files again while keeping their tickets, specs and cells.

The script needs `python3` 3.8 or later. If it is missing, say so and stop.
