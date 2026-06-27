// Scripts/options/option_4.11.js

module.exports = async function (helpers) {
  const { ctx } = helpers;

  ctx.log('--- GoCD Admin Credentials ---', '\x1b[36m');
  ctx.log(`Username: ${ctx.GOCD_USER}`, '\x1b[36m');
  ctx.log(`Password: ${ctx.GOCD_PASS}`, '\x1b[36m');
  ctx.log(`GoCD URL: ${ctx.GOCD_BASE}`, '\x1b[36m');

  // ── Test /go/api/agents (basic auth only) ──
  ctx.log('\nTesting /go/api/agents...', '\x1b[33m');
  const agentsResult = ctx.sh(
    `docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" "${ctx.GOCD_BASE}/go/api/agents"`,
    { stdio: 'pipe' }
  );
  if (typeof agentsResult === 'string') {
    try {
      JSON.parse(agentsResult);
      ctx.log('✅ Agents endpoint – authentication OK, JSON returned.', '\x1b[32m');
    } catch (_) {
      ctx.log('⚠ Agents returned non‑JSON:', '\x1b[33m');
      console.log(agentsResult.substring(0, 400));
    }
  } else {
    ctx.log('❌ Agents command failed (container down?).', '\x1b[31m');
  }

  // ── Test /go/api/pipelines WITH the correct Accept header ──
  ctx.log('\nTesting /go/api/pipelines (with v3 header)...', '\x1b[33m');
  const pipelinesResult = ctx.sh(
    `docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -H "Accept: application/vnd.go.cd+json" "${ctx.GOCD_BASE}/go/api/pipelines"`,
    { stdio: 'pipe' }
  );
  if (typeof pipelinesResult === 'string') {
    try {
      const json = JSON.parse(pipelinesResult);
      const pipelineList = json._embedded?.pipelines || json.pipelines || [];
      ctx.log(`✅ Pipelines endpoint returned ${pipelineList.length} pipelines.`, '\x1b[32m');
    } catch (_) {
      ctx.log('⚠ Pipelines returned non‑JSON. Full response:', '\x1b[33m');
      console.log(pipelinesResult);
    }
  } else {
    ctx.log('❌ Pipelines command failed.', '\x1b[31m');
  }

  await ctx.pause();
};