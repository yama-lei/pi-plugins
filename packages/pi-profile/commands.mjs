import { checkSavePaths, describeProfile, listGlobalProfiles, projectProfilePath, readProfile, registeredProfilePath, saveProfile, syncProfile, validateProfile } from './profile.mjs';
import { setupPrompt } from './setup.mjs';

export function registerProfileCommands(pi, { agentDir, parameters, mutate, download }) {
  let busy = false;
  const requireUI = ctx => {
    if (!ctx.hasUI) throw new Error('Profile installation requires interactive confirmation (TUI or a dialog-capable RPC client).');
  };
  const locked = async task => {
    if (busy) throw new Error('Another profile operation is in progress.');
    busy = true;
    try { return await task(); } finally { busy = false; }
  };
  const startSetup = async (args, ctx) => {
    if (busy) throw new Error('Another profile operation is in progress.');
    pi.sendUserMessage(setupPrompt(ctx.cwd, agentDir, args), { deliverAs: 'followUp' });
  };
  const apply = async (profile, ctx, create) => {
    requireUI(ctx);
    if (!await ctx.ui.confirm('Initialize this project?', `${ctx.cwd}\n\n${describeProfile(profile)}`)) return false;
    if (create) await mutate(projectProfilePath(ctx.cwd), () => saveProfile({ cwd: ctx.cwd, agentDir, profile }));
    try {
      const result = await syncProfile({
        cwd: ctx.cwd,
        profile,
        run: (command, args, options) => pi.exec(command, args, options),
        download,
        onProgress: message => ctx.ui.setStatus('profile', message),
      });
      ctx.ui.notify(result.join('\n') || 'Profile has no resources to install.', 'info');
      return true;
    } finally { ctx.ui.setStatus('profile', undefined); }
  };

  pi.registerCommand('profile', {
    description: 'Initialize project resources: /profile init [name] | /profile sync',
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      let reload = false;
      try {
        requireUI(ctx);
        reload = await locked(async () => {
          await ctx.waitForIdle();
          if (words[0] === 'sync' && words.length === 1) {
            return apply(await readProfile(projectProfilePath(ctx.cwd)), ctx, false);
          }
          if (words[0] !== 'init' || words.length > 2) throw new Error('Usage: /profile init [name] | /profile sync');
          let name = words[1];
          if (!name) {
            const names = await listGlobalProfiles(agentDir);
            const choices = [...names.map(n => `Use profile: ${n}`), 'Set up a profile with the LLM'];
            const selected = await ctx.ui.select('Initialize project profile', choices);
            if (!selected) return false;
            if (selected === choices.at(-1)) {
              pi.sendUserMessage(setupPrompt(ctx.cwd, agentDir), { deliverAs: 'followUp' });
              return false;
            }
            name = names[choices.indexOf(selected)];
            if (!name) throw new Error('Unknown profile selection.');
          }
          const profile = await readProfile(registeredProfilePath(agentDir, name));
          await checkSavePaths({ cwd: ctx.cwd, agentDir });
          return apply(profile, ctx, true);
        });
      } catch (error) {
        ctx.ui.notify(error.message, 'error');
      }
      // Reload replaces this runtime; never touch ctx after this call.
      if (reload) await ctx.reload();
    },
  });

  pi.registerCommand('profile-setup-with-llm', {
    description: 'Ask the current model to discover resources and build a project profile',
    handler: async (args, ctx) => {
      try { await startSetup(args, ctx); }
      catch (error) { ctx.ui.notify(error.message, 'error'); }
    },
  });

  pi.registerTool({
    name: 'profile_save',
    label: 'Save Pi profile',
    description: 'After the user approves a profile, save project JSON, optionally register a new global template, then queue /profile sync. Never overwrites existing profiles. Requires interactive confirmation.',
    parameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      const result = await locked(async () => {
        requireUI(ctx);
        const profile = validateProfile(input.profile);
        await checkSavePaths({ cwd: ctx.cwd, agentDir, globalName: input.globalName });
        const registration = input.globalName === undefined ? 'No global registration.' : `Register global JSON template: ${input.globalName}`;
        if (!await ctx.ui.confirm('Save this profile and queue installation?', `${describeProfile(profile)}\n\n${registration}`)) {
          return { content: [{ type: 'text', text: 'Cancelled. No profile was saved or installed.' }], details: { saved: false } };
        }
        signal?.throwIfAborted();
        await mutate(projectProfilePath(ctx.cwd), () => saveProfile({ cwd: ctx.cwd, agentDir, profile, globalName: input.globalName }));
        return {
          content: [{ type: 'text', text: 'Profile saved. /profile sync has been queued for confirmation and installation; installation is not complete yet.' }],
          details: { saved: true, registeredAs: input.globalName, queued: '/profile sync' },
        };
      });
      // Pi dispatches extension commands immediately. Release our lock before handing off;
      // the command waits for the agent to become idle without blocking this tool's result.
      if (result.details.saved) pi.sendUserMessage('/profile sync', { deliverAs: 'followUp', expandPromptTemplates: true });
      return result;
    },
  });
}
