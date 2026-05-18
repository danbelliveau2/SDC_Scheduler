/* ----------------------------------------------------------------------
 *  phases.js
 *  Static taxonomy used by the schedule grid: phases, sections, departments,
 *  sub-departments, hierarchy colors, milestone library, financial defaults,
 *  and the SDC team directory. In production these come from /api/settings;
 *  here they're hard-coded so the demo has believable data.
 * ---------------------------------------------------------------------- */

window.SDC = window.SDC || {};

window.SDC.PHASES = [
  { key: 'concept',    label: 'Concept',         bg: '#e0e7ff', text: '#3730a3' },
  { key: 'mech',       label: 'Mechanical',      bg: '#dbeafe', text: '#1e3a8a' },
  { key: 'elec',       label: 'Electrical',      bg: '#fee2e2', text: '#9b1c1c' },
  { key: 'ctrls',      label: 'Controls',        bg: '#f3e8ff', text: '#6b21a8' },
  { key: 'procure',    label: 'Procurement',     bg: '#fef3c7', text: '#92400e' },
  { key: 'fab',        label: 'Fabrication',     bg: '#fed7aa', text: '#9a3412' },
  { key: 'assy',       label: 'Assembly',        bg: '#cffafe', text: '#155e75' },
  { key: 'commission', label: 'Commissioning',   bg: '#dcfce7', text: '#166534' },
  { key: 'fat',        label: 'FAT',             bg: '#d9f99d', text: '#3f6212' },
  { key: 'install',    label: 'Install',         bg: '#fae8ff', text: '#86198f' }
];

window.SDC.SECTIONS = [
  { key: 'design_build',     label: 'Section 10 — Design & Build',       num: '10' },
  { key: 'machine_testing',  label: 'Section 40 — Machine Testing',      num: '40' },
  { key: 'teardown_install', label: 'Section 50 — Teardown & Install',   num: '50' }
];

window.SDC.HIERARCHY_COLORS = [
  { key: 'engineering', label: 'Engineering',        fill: '#dbeafe', text: '#1e3a8a' },
  { key: 'procurement', label: 'Procurement',        fill: '#fef3c7', text: '#92400e' },
  { key: 'shop',        label: 'Shop',               fill: '#fed7aa', text: '#9a3412' },
  { key: 'mech',        label: '— Mechanical',       fill: '#e0e7ff', text: '#3730a3' },
  { key: 'elec',        label: '— Electrical',       fill: '#fee2e2', text: '#9b1c1c' },
  { key: 'ctrls',       label: '— Controls',         fill: '#f3e8ff', text: '#6b21a8' },
  { key: 'fab',         label: '— Fabrication',      fill: '#fed7aa', text: '#9a3412' },
  { key: 'assy',        label: '— Assembly',         fill: '#cffafe', text: '#155e75' },
  { key: 'install',     label: 'Install',            fill: '#fae8ff', text: '#86198f' }
];

window.SDC.MILESTONE_LIBRARY = [
  { name: 'Mech Concept Release',  section: 'Section 10', dept: 'Engineering / Mechanical' },
  { name: 'Detail Design Review',  section: 'Section 10', dept: 'Engineering / Mechanical' },
  { name: 'Elec Schematic Done',   section: 'Section 10', dept: 'Engineering / Electrical' },
  { name: 'PLC Code Freeze',       section: 'Section 10', dept: 'Engineering / Controls'   },
  { name: 'Long Lead Order Cut',   section: 'Section 10', dept: 'Procurement'              },
  { name: 'Frame Weld-out',        section: 'Section 10', dept: 'Shop / Fabrication'       },
  { name: 'Sub-assembly Complete', section: 'Section 10', dept: 'Shop / Assembly'          },
  { name: 'Mech Debug Complete',   section: 'Section 40', dept: 'Shop'                     },
  { name: 'Elec Commission Done',  section: 'Section 40', dept: 'Shop'                     }
];

window.SDC.FINANCIAL_DEFAULTS = [
  { name: 'PO Receipt',         pct: 20, syncTo: 'Receipt of PO' },
  { name: 'Mech Design Review', pct: 15, syncTo: '—'              },
  { name: 'Long Lead Ordered',  pct: 15, syncTo: '—'              },
  { name: 'Power-up',           pct: 20, syncTo: 'Machine Power-Up' },
  { name: 'FAT Sign-off',       pct: 20, syncTo: 'FAT'            },
  { name: 'Ship + Install',     pct: 10, syncTo: 'Ship Machine'   }
];

window.SDC.TEAM = {
  Mechanical: ['Riley Tomas', 'Sam Pham', 'Devon Carr', 'Priya Anand'],
  Electrical: ['Jordan Wells', 'Maya Cohen', 'Tariq Rahim'],
  Controls:   ['Alex Yu', 'Bobby Chen', 'Liz Hardt'],
  Shop:       ['Kade Lindstrom', 'Vince Pareto', 'Hannah Ohr', 'Marcus Reed', 'Theo Bell']
};
