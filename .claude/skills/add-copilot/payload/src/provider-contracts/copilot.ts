import { COPILOT_PROJECT_DOC_MAX_BYTES } from '../providers/copilot-agents-md.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  registerProviderHostContract,
} from './registry.js';

registerProviderHostContract('copilot', {
  modelEndpoints: {
    api: 'https://api.githubcopilot.com',
    token: 'https://github.com/login/oauth/access_token',
  },
  modelDomains: [
    'github.com',
    'api.github.com',
    'api.githubcopilot.com',
    'copilot-proxy.githubusercontent.com',
  ],
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    maxBytes: COPILOT_PROJECT_DOC_MAX_BYTES,
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    instructions: {
      nativeOverrideFiles: ['.github/copilot-instructions.md', 'AGENTS.override.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.agents/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.copilot/skills',
        persistentRoots: ['~/.copilot', '~/.agents'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      id: 'copilot-home',
      directory: '.copilot-shared',
      containerPath: '/home/node/.copilot',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'copilot-skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'copy',
    },
  ],
  skillViews: [
    {
      backingId: 'copilot-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
    {
      backingId: 'copilot-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
  ],
  files: [],
  commands: {
    nativeAdmin: [],
    nativeFiltered: [],
  },
  inference: { speedTiers: ['standard'] },
  legacyHostAdapter: 'required',
});
