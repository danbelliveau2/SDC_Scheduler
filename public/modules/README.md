# Frontend Modules

This directory holds ES module files extracted from `app.js`.

## Planned structure

```
modules/
  api.js        ← REST client (fetch wrappers for every resource)
  state.js      ← global state object + loadTasks / loadTeam / loadSettings
  scheduler.js  ← client-side cascade math, predecessor parsing, business-day logic
  render.js     ← renderTable(), renderGantt(), alignGanttToGrid()
  gantt.js      ← Gantt decorators (drawCriticalPath, drawBaselineGhosts, etc.)
  ui.js         ← showToast, showAlertDialog, showContextMenu, modals
  events.js     ← all click/drag/keyboard event handlers (init entry point)
```

## Migration strategy

app.js is currently a 23k-line monolith. Modules are extracted one at a time:
1. Extract self-contained, no-circular-dep pieces first (scheduler math, constants)
2. Extract api.js once showToast / loadTasks references are removed from it
3. Extract state.js, then render.js imports state
4. Extract gantt.js (depends on state + render)
5. Extract events.js last (depends on everything)

Each extraction: add `export` to moved functions, `import` in consumers, test.
Do NOT break the existing app.js global scope until a module is fully wired.
