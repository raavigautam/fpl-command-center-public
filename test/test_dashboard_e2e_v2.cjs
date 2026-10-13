// The end-to-end dashboard suite again, on the component model, so the
// decision code (transfers, captain, chips, roadmap) is proven on both.
process.env.XP_MODEL = 'v2';
require('./test_dashboard_e2e.cjs');
