// The end-to-end dashboard suite on the points-trend model (v1), so the
// fallback path stays proven now the app defaults to a v2 blend.
process.env.XP_MODEL = 'v1';
require('./test_dashboard_e2e.cjs');
