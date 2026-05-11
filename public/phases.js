// SDC project phases — top-level buckets matching the standard project schedule.
// Engineering side: ME, CE, Engineering (general).  Shop side: Build, Wire.  Plus Testing.
// Edit hex colors to retheme.
window.PHASES = [
  { key: 'me',          label: 'ME — Mechanical',  color: '#bfdbfe', text: '#1e3a8a' }, // blue
  { key: 'ce',          label: 'CE — Controls',    color: '#bbf7d0', text: '#14532d' }, // green (incl. software, drawings, programming)
  { key: 'engineering', label: 'Engineering',      color: '#e9d5ff', text: '#581c87' }, // purple (general / cross-cutting)
  { key: 'build',       label: 'Build',            color: '#fed7aa', text: '#7c2d12' }, // orange
  { key: 'wire',        label: 'Wire',             color: '#fef08a', text: '#713f12' }, // yellow
  { key: 'testing',     label: 'Testing',          color: '#fecaca', text: '#991b1b' }, // red
];

window.PHASE_BY_KEY = Object.fromEntries(window.PHASES.map(p => [p.key, p]));

// Hierarchy used to group tasks in the grid: PROJECT > phase_group > department > sub_department > task.
// Sub-departments are optional — a department with `subs: []` puts tasks directly under it.
window.HIERARCHY = [
  {
    key: 'design_build', label: '10 DESIGN & BUILD',
    departments: [
      {
        key: 'engineering', label: 'ENGINEERING',
        subs: [
          { key: 'mech',     label: 'MECHANICAL ENGINEERING' },
          { key: 'controls', label: 'CONTROLS ENGINEERING' },
          { key: 'general',  label: 'GENERAL ENGINEERING' },
        ],
      },
      // Procurement sits between Engineering and Shop because long-lead orders kick off
      // during/after design and have to land before Shop can build.
      { key: 'procurement', label: 'PROCUREMENT', subs: [] },
      {
        key: 'shop', label: 'SHOP',
        subs: [
          { key: 'build', label: 'BUILD' },
          { key: 'wire',  label: 'WIRE' },
        ],
      },
    ],
  },
  {
    key: 'machine_testing', label: '40 MACHINE TESTING',
    departments: [
      { key: 'engineering', label: 'ENGINEERING', subs: [] },
      { key: 'shop',        label: 'SHOP',        subs: [] },
    ],
  },
  // Section 50 spans both teardown (at SDC) and install (at the customer's site).
  // Teardown is shop-only (no engineering — it's just disassembling). Install needs
  // both engineering and shop hands. Ship Machine (a hard-coded anchor milestone)
  // sits between Teardown and Install within this section.
  {
    key: 'teardown_install', label: '50 TEARDOWN & INSTALL',
    departments: [
      { key: 'teardown', label: 'TEARDOWN', subs: [] },
      { key: 'install',  label: 'INSTALL',
        // Shop comes BEFORE engineering on install — the shop crew rebuilds the
        // machine on site first, then engineering powers it up / commissions.
        subs: [
          { key: 'shop',        label: 'SHOP' },
          { key: 'engineering', label: 'ENGINEERING' },
        ],
      },
    ],
  },
];

window.GROUP_BY_KEY = Object.fromEntries(window.HIERARCHY.map(g => [g.key, g]));
window.findDepartment = (groupKey, deptKey) =>
  (window.GROUP_BY_KEY[groupKey]?.departments || []).find(d => d.key === deptKey) || null;
window.findSubDepartment = (groupKey, deptKey, subKey) =>
  (window.findDepartment(groupKey, deptKey)?.subs || []).find(s => s.key === subKey) || null;
