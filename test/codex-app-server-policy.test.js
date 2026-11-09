import assert from 'node:assert/strict';
import test from 'node:test';
import { appServerArguments, threadConfiguration, reviewerConfiguration, assertEffectiveAppServerPolicy } from '../src/lib/codex-app-server-policy.js';

test('app-server policy uses supported overrides without moving native home',()=>{
  const args=appServerArguments({model:'gpt-6.1-sol',reasoningEffort:'high'},'D:/private/instructions.txt',true);
  assert.equal(args[0],'app-server');assert.ok(args.includes('--stdio'));assert.equal(args.includes('--strict-config'),false);
  assert.equal(args.includes('--ignore-user-config'),false);assert.equal(args.includes('--ignore-rules'),false);
  assert.ok(args.includes('features.shell_tool=false'));assert.ok(args.includes('notify=[]'));
  assert.ok(args.includes('features.code_mode_host=true'));
  assert.ok(args.includes('features.multi_agent_v2=false'));
  assert.ok(args.includes('agents.max_concurrent_threads_per_session=3'));
});

test('native requests and reviewer agents use standard service for both models', () => {
  for (const request of [{model:'gpt-6-luna',reasoningEffort:'medium'}, {model:'gpt-6.1-sol',reasoningEffort:'high'}]) {
    for (const review of [true, false]) {
      const args = appServerArguments(request, 'D:/private/instructions.txt', review);
      assert.ok(args.includes('service_tier="default"'));
      assert.ok(args.includes(`model=${JSON.stringify(request.model)}`));
      assert.ok(args.includes(`model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`));
    }
    assert.match(reviewerConfiguration(request, 'D:/private/instructions.txt'), /^service_tier="default"$/m);
  }
});

test('thread resume overrides inherited accelerated tiers without changing home settings', () => {
  for (const service_tier of [undefined, 'auto', 'fast', 'priority', 'ultrafast', 'default']) {
    for (const channel of ['review', 'code-job']) {
      const inherited = {service_tier};
      const options = channel === 'code-job' ? {channel, namespace:'dih_code_job_0123456789abcdef', execution:{url:'http://127.0.0.1:1234/execution'}} : {channel};
      assert.equal(threadConfiguration(inherited, options).service_tier, 'default');
      assert.equal(inherited.service_tier, service_tier);
    }
  }
});

test('thread policy disables each inherited MCP without copying private configuration',()=>{
  const configured={mcp_servers:{'old.server':{command:'secret',env:{TOKEN:'private'}},'odd"name':{url:'private'}},
    agents:{default:{config_file:'D:/unsafe.toml'},custom:{config_file:'D:/other.toml'},enabled:true,max_depth:8}};
  const result=threadConfiguration(configured,{reader:{url:'http://127.0.0.1:1234/review/token'},agentConfigPath:'D:/private/reviewer.toml',namespace:'dih_pr_review_0123456789abcdef'});
  assert.equal(result.mcp_servers['old.server'].enabled,false);
  assert.equal(result.mcp_servers['odd"name'].enabled,false);
  assert.equal(result.mcp_servers.dih_pr_review_0123456789abcdef.url,'http://127.0.0.1:1234/review/token');
  assert.equal(result.agents.custom.config_file,'D:/private/reviewer.toml');
  assert.equal(JSON.stringify(result).includes('private"'),false);
  assert.equal(JSON.stringify(result).includes('unsafe.toml'),false);
});

test('each thread preserves the process isolation flags instead of reopening desktop tools', () => {
  const inherited = { features: { apps: true, computer_use: true, shell_tool: true, plugins: true, multi_agent: true }, agents: { enabled: true } };
  for (const options of [{}, { channel: 'code-job', namespace: 'dih_code_job_0123456789abcdef', execution: { url: 'http://127.0.0.1:1234/execution' } }]) {
    const thread = threadConfiguration(inherited, options);
    for (const feature of ['apps', 'computer_use', 'shell_tool', 'plugins', 'remote_plugin', 'code_mode', 'multi_agent_v2']) {
      assert.equal(thread.features[feature], false, feature);
    }
    assert.equal(thread.features.skip_host_skill_discovery, true);
    assert.equal(thread.features.code_mode_host, true);
    assert.equal(thread.features.multi_agent, options.channel !== 'code-job');
    assert.equal(inherited.features.apps, true);
  }
});

test('resuming a code-job thread for read-only review restores only the host-enabled reviewer capability', () => {
  const reviewer = { features: { multi_agent: true }, agents: { enabled: true, default: {} } };
  const code = threadConfiguration(reviewer, { channel: 'code-job', namespace: 'dih_code_job_0123456789abcdef',
    execution: { url: 'http://127.0.0.1:1234/execution' }, agentConfigPath: 'D:/private/child.toml' });
  const review = threadConfiguration(reviewer, { namespace: 'dih_pr_review_0123456789abcdef',
    reader: { url: 'http://127.0.0.1:1234/read' }, agentConfigPath: 'D:/private/reviewer.toml' });
  const resumed = { features: { multi_agent: false, ...review.features }, agents: { ...code.agents, ...review.agents } };
  assert.equal(resumed.features.multi_agent, true);
  assert.equal(resumed.agents.enabled, true);
  assert.equal(resumed.agents.default.config_file, 'D:/private/reviewer.toml');
  assert.equal(review.mcp_servers.dih_pr_review_0123456789abcdef.enabled_tools.includes('perform_action'), false);
  for (const host of [{}, { features: { multi_agent: false }, agents: { enabled: false } },
    { features: { multi_agent: true }, agents: { enabled: false } },
    { features: { multi_agent: false }, agents: { enabled: true } }]) {
    const advisory = threadConfiguration(host, {});
    assert.equal(advisory.features.multi_agent, false);
    assert.equal(advisory.agents.enabled, false);
  }
  assert.equal(code.features.multi_agent, false);
  assert.equal(code.agents.enabled, false);
});

test('thread policy refuses alias collisions and malformed inventories',()=>{
  const options={namespace:'dih_pr_review_0123456789abcdef',reader:{url:'http://127.0.0.1:1234/review/token'},agentConfigPath:'D:/private/role.toml'};
  assert.throws(()=>threadConfiguration({mcp_servers:{[options.namespace]:{}}},options),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>threadConfiguration({mcp_servers:[]},options),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
});

test('code-job policy exposes only host execution tools in a separate namespace',()=>{
  const options={channel:'code-job',namespace:'dih_code_job_0123456789abcdef',
    execution:{url:'http://127.0.0.1:1234/code-execution/token'},agentConfigPath:'D:/private/role.toml'};
  const result=threadConfiguration({mcp_servers:{pr_review:{url:'private'}},agents:{enabled:true,default:{config_file:'unsafe'}}},options);
  assert.equal(result.mcp_servers.pr_review.enabled,false);
  const expectedTools=['perform_action','read_source','edit_source','get_state','read_conflict_source'];
  assert.deepEqual(result.mcp_servers[options.namespace].enabled_tools,expectedTools);
  assert.deepEqual(Object.keys(result.mcp_servers[options.namespace].tools),expectedTools);
  assert.equal(result.mcp_servers[options.namespace].tool_timeout_sec,2460, 'native MCP must outlast the bounded fixed profile and its host receipt');
  assert.equal(result.agents.enabled,false);
  assert.throws(()=>threadConfiguration({}, {...options,reader:{url:'private'}}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>threadConfiguration({}, {...options,namespace:'dih_pr_review_0123456789abcdef'}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>threadConfiguration({mcp_servers:{[options.namespace]:{}}},options),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>assertEffectiveAppServerPolicy({}, {channel:'unexpected'}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
});
