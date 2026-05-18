const db = require('../db');

async function cleanupProject(projectId) {
  console.log(`Starting cleanup for Job ${projectId}...`);

  const toDelete = [
    'Kick-Off Phase', 'Project Information Log', 'Project Planner', 'Project Links', 'BOM', 'Dashboard', 'Internal Deadlines',
    'Communication Plan', 'Status Update', 'SDC Project Summary', 'Project Contacts', 'Dashboard Schedule', 'Customer Schedule', 'Customer Key Dates'
  ];
  
  await db.begin();
  try {
    const deleteSql = "DELETE FROM tasks WHERE project = ? AND (name IS NULL OR name = '' OR name IN (" + toDelete.map(() => '?').join(',') + "))";
    const delResult = await db.run(deleteSql, [projectId, ...toDelete]);
    console.log(`Deleted ${delResult.changes} organizational rows.`);

    const allTasks = await db.all('SELECT id, name FROM tasks WHERE project = ?', [projectId]);
    const updateSql = 'UPDATE tasks SET phase = ?, phase_group = ?, department = ?, sub_department = ?, is_milestone = ?, anchor_key = ? WHERE id = ?';

    let currentPhase = null;
    let currentPhaseGroup = null;
    let currentDept = null;
    let currentSubDept = null;

    for (const t of allTasks) {
      const name = (t.name || '').toLowerCase();
      let phase = null;
      let phaseGroup = null;
      let dept = null;
      let subDept = null;
      let isMilestone = null;
      let anchorKey = null;

      if (name.includes('me development') || name.includes('mech design')) {
        currentPhase = 'me'; currentPhaseGroup = 'design_build'; currentDept = 'engineering'; currentSubDept = 'mech';
      } else if (name.includes('machine control') || name.includes('ce phase') || name.includes('controls design')) {
        currentPhase = 'ce'; currentPhaseGroup = 'design_build'; currentDept = 'engineering'; currentSubDept = 'controls';
      } else if (name.includes('procurement') || name.includes('receiving')) {
        currentPhase = null; currentPhaseGroup = 'design_build'; currentDept = 'procurement'; currentSubDept = null;
      } else if (name.includes('mechanical build') || name.includes('builder')) {
        currentPhase = 'build'; currentPhaseGroup = 'design_build'; currentDept = 'shop'; currentSubDept = null;
      } else if (name.includes('electrical build') || name.includes('wiring') || name.includes('panel building')) {
        currentPhase = 'wire'; currentPhaseGroup = 'design_build'; currentDept = 'shop'; currentSubDept = 'wire';
      } else if (name.includes('machine power-up')) {
        phase = 'wire'; phaseGroup = 'design_build'; dept = 'shop'; subDept = 'wire'; isMilestone = 1; anchorKey = 'machine_power_up';
      } else if (name.includes('testing at sdc') || name.includes('machine testing') || name.includes('debug')) {
        currentPhase = 'testing'; currentPhaseGroup = 'machine_testing'; currentDept = 'engineering'; currentSubDept = null;
      } else if (name.includes('fat') && !name.includes('preparation')) {
        phase = 'testing'; phaseGroup = 'machine_testing'; isMilestone = 1; anchorKey = 'fat';
      } else if (name.includes('shipping') || name.includes('teardown')) {
        currentPhase = null; currentPhaseGroup = 'teardown_install'; currentDept = 'teardown'; currentSubDept = null;
      } else if (name.includes('ship machine')) {
        phase = null; phaseGroup = 'teardown_install'; isMilestone = 1; anchorKey = 'ship_machine';
      } else if (name.includes('receipt of po') || name.includes('po received')) {
        phase = null; phaseGroup = null; isMilestone = 1; anchorKey = 'receipt_of_po';
      }

      if (!anchorKey) {
        phase = phase || currentPhase;
        phaseGroup = phaseGroup || currentPhaseGroup;
        dept = dept || currentDept;
        subDept = subDept || currentSubDept;
      }

      await db.run(updateSql, [phase, phaseGroup, dept, subDept, isMilestone, anchorKey, t.id]);
    }

    await db.run("UPDATE tasks SET phase_group = NULL WHERE project = ? AND anchor_key IN ('receipt_of_po', 'fat', 'ship_machine')", [projectId]);

    await db.commit();
    console.log('Cleanup complete.');
  } catch (err) {
    await db.rollback();
    console.error('Cleanup failed:', err);
  }
}

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node cleanup_project.js <projectId>');
  process.exit(1);
}

cleanupProject(projectId);
