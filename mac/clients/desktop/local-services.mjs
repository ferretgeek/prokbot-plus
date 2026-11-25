import { grokText } from './i18n.mjs';
import { createConnectorHandlers } from './connectors.mjs';
import { externalHttpUrl } from './external-url.mjs';
import { createLinkPreview } from './link-preview.mjs';
import { createClientPersistence } from './client-persistence.mjs';
import { createDictation } from './dictation.mjs';
export const auth = {
  kind: "logged-in",
  authId: "grokbot-local-workspace",
  email: "",
  displayName: "本地工作区",
  profileReady: true,
  isAnysphereUser: false,
  freshness: 0,
};
export const theme = {
  preference: "dark",
  resolved: "dark",
  systemAccentColor: null,
};
export const language = { preference: "en", resolved: "en" };
export const experiments = {
  featureGates: {
    sand_create_temporal_agents: false,
    grok_bot_box_harness_turns_blocked: false,
    sand_profile_photo_edit: true,
    sand_teach_by_demonstration: true,
    publish_user_skills: true,
    agent_prompted_cookie_sync: true,
    sand_voice_call: false,
    sand_voice_resumption: false,
  },
  dynamicConfigs: {},
};
export const boot = {
  mainEdge: "served",
  theme,
  language,
  experiments,
  isAssistiveTechEnabled: false,
  isEgressTunnelEnabled: false,
  isWebauthnProxyEnabled: true,
  isBotColorInChatEnabled: false,
  egressTunnelStatus: { enabled: false, active: false },
  rosterPhotos: null,
  computerUseHelperName: "Grok Bot Computer Use",
};
const access = {
  state: "granted",
  reason: "none",
  privacyDisclaimerRequired: false,
  purchasableTiers: [],
  proAndSuperGrokPlansGrantAccess: false,
  isUnified: false,
};
export function probeLocalMethod(trusted, declared, call, method) {
  return { ok: Boolean(trusted), value: Boolean(trusted && declared.has(method) && call?.supports(method)) };
}

/**
 * Methods of each RPC edge in the official preload. The minified declaration
 * helper is renamed per build (`t()` in 0.71.2, `n()` in 1.1.0). Edges other
 * than `main` declare their methods inline; `main` keeps everything else.
 */
export function desktopEdges(preload) {
  const declared = source => [...source.matchAll(/([A-Za-z_$][\w$]*):[A-Za-z_$][\w$]*\(\)\.(?:args|noArgs)/g)].map(match => match[1]);
  const counts = new Map();
  for (const name of declared(preload)) counts.set(name, (counts.get(name) ?? 0) + 1);
  const others = new Map();
  for (const match of preload.matchAll(/\("([a-z][a-z-]*)",\{methods:\{/g)) {
    if (match[1] === 'main') continue;
    let end = match.index + match[0].length - 1;
    for (let depth = 0; end < preload.length; end++) {
      if (preload[end] === '{') depth++;
      else if (preload[end] === '}' && --depth === 0) break;
    }
    const names = declared(preload.slice(match.index, end));
    others.set(match[1], new Set(names));
    for (const name of names) counts.set(name, counts.get(name) - 1);
  }
  return { main: new Set([...counts].filter(([, count]) => count > 0).map(([name]) => name)), others };
}

export async function createLocalServices(profile, window, { command, request, attachment, attachmentHandlers = {}, connection, disconnect, notifications, pickAvatarFile, openExternal, settings = {}, appVersion, persistence = createClientPersistence(profile), emit = () => {} }) {
  const linkPreview = createLinkPreview({ profile });
  const known = {
    getLinkMetadata: args => linkPreview.getMetadata(args),
    resolveAttachmentMedia: attachment,
    ...attachmentHandlers,
    // 0.71.2 sends a finished recording; 1.1.0 streams it through the dictation methods.
    transcribeAudio: ({ audio, mimeType, language }) => request('/local/audio/transcriptions', {
      audioBase64: Buffer.from(audio).toString('base64'), mimeType,
      ...(language ? { language } : {}),
    }, AbortSignal.timeout(120000)),
    ...createDictation({ request, emit: value => emit('dictation-text', value) }),
    openSelfHostedConnection: connection,
    loginCursor: connection,
    logoutCursor: disconnect,
    addCursorAccount: connection,
    pickAvatarFile,
    listGrokBotAgentFiles: ({ agentId }) => request(`/local/files?agentId=${encodeURIComponent(agentId)}`, null, AbortSignal.timeout(15000), 'GET'),
    uploadGrokBotAgentFile: ({ agentId, fileName, contentType, bytes }) => request('/local/files',
      { agentId, fileName, contentType, base64: Buffer.from(bytes).toString('base64') }, AbortSignal.timeout(60000)),
    deleteGrokBotAgentFile: async ({ agentId, name }) => { await request('/local/files', { agentId, name }, AbortSignal.timeout(15000), 'DELETE'); },
    // 1.1.0 also lists files a cloud Bot keeps per user; Host Bots keep only their library.
    listGrokBotUserStoreFiles: () => ({ files: [] }),
    deleteGrokBotUserStoreFile: () => null,
    getAutoReviewInstructions: async () => (await command('getHostSettings')).autoReviewInstructions ?? { isEnabled: false, allowInstructions: [], blockInstructions: [] },
    setAutoReviewInstructions: async ({ instructions }) => {
      await command('setHostSettings', { autoReviewInstructions: instructions });
      return (await command('getHostSettings')).autoReviewInstructions;
    },
    getDesktopNotificationPreferences: () => notifications.getPreferences(),
    setDesktopNotificationPreferences: ({ preferences }) => notifications.setPreferences(preferences),
    setComposingAgent: () => null,
    clearLocalToolApprovals: () => null,
    peekUsageWarningAssignment: () => null,
    getCursorWeeklyUsage: () => null,
    reportClientFailure: () => null,
    getTimeZone: () => ({
      detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      overrideTimeZone: null,
    }),
    signalBoxIntent: () => null,
    setComputerViewOpen: () => null,
    getOnboardingSeen: () => true,
    setOnboardingSeen: () => null,
    markDeepLinksReady: () => null,
    setViewingAgent: ({ agentId }) => notifications.noteViewingAgent(agentId),
    getCursorPrReviewPreferences: () => ({}),
    getCursorUsageSummary: () => null,
    getBoxMigrationStatus: () => null,
    getBoxHostPhase: () => "settled",
    getTeamMemberPolicy: () => null,
    // null lets the original migration read Host pins; [] would mean a cloud-side clear.
    getServerPinnedAgents: () => null,
    // These are desktop IPC methods; the Host persists both in its settings RPC.
    getHostPinnedAgents: async () => (await command('getHostSettings')).pinnedAgentIds ?? null,
    setHostPinnedAgents: async ({ pinnedAgentIds }) =>
      (await command('setHostSettings', { pinnedAgentIds })).pinnedAgentIds ?? null,
    getHostSidebarSections: async () => (await command('getHostSettings')).sidebarSections ?? null,
    setHostSidebarSections: async ({ sections }) =>
      (await command('setHostSettings', { sidebarSections: sections })).sidebarSections ?? null,

    getCursorAuthStatus: () => auth,
    getCursorLoginFlight: () => ({ kind: "idle" }),
    listCursorAccounts: () => ({
      accounts: [auth],
      activeAccountId: auth.authId,
      corrupt: false,
    }),
    getCursorSelectedTeam: () => ({ selectedTeamId: null, fallback: null }),
    listCursorTeamMemberships: () => [],
    listCursorTeamMembers: () => ({ members: [] }),
    getGrokBotInviteByEmailEligibility: () => "unknown",
    getCursorAvatar: () => null,
    getSandAccess: () => access,
    getSandAccessFresh: () => access,
    getGrokBotTermsRecord: () => ({ seenAtMs: Date.now(), version: 1 }),
    getThemeState: () => theme,
    getLanguageState: () => language,
    getExperimentsSnapshot: () => experiments,
    getWindowState: () => ({
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
      isFocused: window.isFocused(),
    }),
    isWindowShown: () => window.isVisible() && !window.isMinimized(),
    minimizeWindow: () => window.minimize(),
    focusWindow: () => window.focus(),
    closeWindow: () => window.close(),
    toggleMaximizeWindow: () =>
      window.isMaximized() ? window.unmaximize() : window.maximize(),
    ...persistence,
    getEgressTunnelEnabled: () => false,
    getEgressTunnelForcedByAdmin: () => false,
    claimEgressTunnel: () => null,
    getWebauthnProxyEnabled: () => true,
    getBotColorInChatEnabled: () => false,
    getEgressTunnelStatus: () => boot.egressTunnelStatus,
    getNotificationPreferences: () => notifications.getPreferences(),
    getHardwareAcceleration: () => true,
    getUpdateStatus: () => ({
      state: { type: "disabled", reason: "disabled-by-env" },
      currentVersion: appVersion,
      currentTrack: "stable",
      availableTracks: ["stable"],
      isTrackManagedByPolicy: true,
      delivery: "package-manager",
      isBelowMinimumVersion: false,
      autoUpdateWhenIdle: false,
    }),
    getCredentialsState: () => ({
      connections: [],
      credentials: [],
      catalogRevision: "local",
    }),
    ...createConnectorHandlers({ command, openExternal }),
    getCursorPrivacyModeEnabled: () => false,
    getCursorStorageAllowed: () => false,
    getCursorUnifyCta: () => null,
    // The original signed-out answers: nothing is offered and nothing is sent to a cloud account.
    getCursorTrainingOptIn: () => "unavailable",
    getCursorTrainingSetting: () => "signed-out",
    getCursorBonfireStatus: () => ({ kind: "ineligible" }),
    getLocalPitmanState: () => ({ isRecorderReady: false, session: null }),
    getPendingRestartToUpdate: () => null,
    getMicrosoftTeamsAccountLinkStatus: () => ({ links: [], teamEnablement: null }),
    getGrokBotTeamsInstallState: () => ({ installed: false }),
    getCurrentMachineMessagesEnabled: () => false,
    getMacMailSendEnabled: () => false,
    getMessagesCapabilities: () => ({ available: false, canSend: false, canRead: false }),
    readScmConnections: () => ({ github: false, gitlab: false, bitbucket: false, 'azure-devops': false }),
    isSlackLinked: () => false,
    listSlackLinkedWorkspaces: () => [],
    listSecrets: () => [],
    listGrokBotSecrets: () => [],
    listGrokBotUserBotMemories: () => [],
    getGrokBotUserSkills: () => ({ heldOnBox: false, skills: [] }),
    listMeetings: () => [],
    listGrokBotAgentMeetings: () => [],
    hasGrokBotAgentPastMeetings: () => false,
    listMessagesAllowedRecipients: () => [],
    listComputerUseAllowedApps: () => [],
    listCloudAgentPublishedApps: () => ({ kind: 'off' }),
    listCloudAgentAvailableAppSecrets: () => [],
    getCloudAgentAppSecrets: () => ({ secrets: [] }),
    getCloudAgentPublishProposals: () => ({ kind: 'off' }),
    listPublicBotMarketplace: () => ({ featuredListings: [], listings: [], hasMore: false }),
    listGrokBotTeamAgents: () => [],
    // 1.3.0 reads. Each answer is what the official client returns when the cloud
    // service has nothing for the account: an empty Bot page, no Bot skills, no team
    // preview, an unranked team list and no plugin server links.
    getBotPage: () => ({}),
    getGrokBotAgentBotSkills: () => [],
    getGrokBotAgentPreview: () => ({ people: [], stats: null, popularWithRoles: [] }),
    browseGrokBotTeamAgents: () => ({ kind: 'unranked' }),
    getPluginMcpServerLinks: () => null,
    getGrokBotAutomationPurchase: () => null,
    // The official handler opens an internal developer window and does nothing in release builds.
    openBotDictationSettings: () => null,
    listCursorTeamGroups: () => [],
    getLocalToolActionGrant: () => ({ granted: false }),
    attachProdBoxStatus: () => ({ enabled: false }),
    getSandMachines: () => ({ machines: [], currentMachineRemoved: false }),
    getFinanceOverview: () => ({ connections: [] }),
    forceReconnectGateway: async () => { await command("listAgents"); return { connected: true }; },
    openExternal: async ({ url }) => {
      if (url?.startsWith('grokbot-local:')) return null;
      const target = externalHttpUrl(url);
      if (!target) throw new Error(grokText('链接地址无效。', 'Invalid link address.'));
      await openExternal(target);
      return null;
    },
    getHostSettings: () => command("getHostSettings"),
    setHostSettings: (args) => command("setHostSettings", args),
  };
  Object.assign(known, settings);
  const supports = method => typeof method === 'string' && Object.hasOwn(known, method) && typeof known[method] === 'function';
  const call = async (method, args = {}) => {
    if (supports(method)) return known[method](args);
    if (
      /^(report|note|expose|log|setTitleBar|setUnreadFilter|setWindow|markGrokBotTerms)/.test(
        method,
      )
    )
      return null;
    console.error("[missing local method]", method);
    throw new Error(`Local desktop does not implement ${method}`);
  };
  // Passive compatibility notices above are not implemented capabilities.
  return Object.assign(call, { supports });
}
