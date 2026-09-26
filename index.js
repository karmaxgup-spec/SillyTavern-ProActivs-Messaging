// Proactive Messaging
//
// If the conversation has been "flowing" (a handful of messages have gone
// back and forth recently) and the user suddenly stops responding while the
// tab is still open ("online"), this extension quietly prompts the current
// LLM to continue as the character would - no meta question, no "are you
// still there?" out-of-character check-in, no extra request asking the model
// to judge the pause. It's just a normal generation call, the same as if the
// user had pressed Send with an empty box.

const MODULE_NAME = 'proactive_messaging';

const defaultSettings = Object.freeze({
    enabled: true,
    idleSeconds: 45,            // silence required before we nudge a follow-up
    minRecentMessages: 4,       // messages needed inside the window below to call it "flowing"
    flowingWindowSeconds: 300,  // window the recent-message count is measured over
    cooldownSeconds: 180,       // minimum gap between two automatic follow-ups
    requireTabFocused: true,    // only fire while this browser tab is the active one
});

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

let idleTimer = null;
let recentActivity = [];   // timestamps (ms) of recent chat activity, any sender
let lastTriggerTime = 0;
let generationInFlight = false;

function log(...args) {
    console.log(`[${MODULE_NAME}]`, ...args);
}

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function recordActivity() {
    const now = Date.now();
    recentActivity.push(now);
    const cutoff = now - 30 * 60 * 1000; // trim anything older than 30 min
    recentActivity = recentActivity.filter((t) => t >= cutoff);
}

function isConversationFlowing(settings) {
    const now = Date.now();
    const windowStart = now - settings.flowingWindowSeconds * 1000;
    const count = recentActivity.filter((t) => t >= windowStart).length;
    return count >= settings.minRecentMessages;
}

function lastMessageIsFromCharacter() {
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return false;
    const last = chat[chat.length - 1];
    return Boolean(last) && last.is_user === false && !last.is_system;
}

function hasUnsentDraft() {
    const val = $('#send_textarea').val();
    return typeof val === 'string' && val.trim().length > 0;
}

function isGenerating() {
    const context = SillyTavern.getContext();
    return generationInFlight || Boolean(context.streamingProcessor);
}

async function tryTriggerProactiveMessage() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (settings.requireTabFocused && document.visibilityState !== 'visible') return;
    if (isGenerating()) return;
    if (hasUnsentDraft()) return;              // user is mid-typing, leave them alone
    if (!lastMessageIsFromCharacter()) return; // only nudge when we're the ones "waiting" on the user
    if (!isConversationFlowing(settings)) return;

    const now = Date.now();
    if (now - lastTriggerTime < settings.cooldownSeconds * 1000) return;

    lastTriggerTime = now;
    generationInFlight = true;
    try {
        const context = SillyTavern.getContext();
        log('User went idle mid-conversation, prompting a natural follow-up.');
        // Equivalent to pressing Send with an empty input box: the character
        // continues the conversation. No extra prompt or question is injected.
        await context.generate('normal');
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to generate proactive message:`, error);
    } finally {
        generationInFlight = false;
    }
}

function scheduleIdleCheck() {
    const settings = getSettings();
    clearIdleTimer();
    if (!settings.enabled) return;
    idleTimer = setTimeout(() => {
        tryTriggerProactiveMessage();
    }, settings.idleSeconds * 1000);
}

function onAnyMessageEvent() {
    recordActivity();
    scheduleIdleCheck();
}

function onGenerationStarted() {
    generationInFlight = true;
    clearIdleTimer();
}

function onGenerationEnded() {
    generationInFlight = false;
    onAnyMessageEvent(); // whatever just finished counts as activity; re-arm the window
}

function onChatChanged() {
    recentActivity = [];
    lastTriggerTime = 0;
    clearIdleTimer();
}

function bindEvents() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    eventSource.on(eventTypes.MESSAGE_SENT, onAnyMessageEvent);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onAnyMessageEvent);
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationEnded);
    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);

    // Reset the idle countdown while the user is actively typing, so a pause
    // for thought never gets interrupted mid-sentence.
    $(document).on('input', '#send_textarea', () => {
        clearIdleTimer();
        scheduleIdleCheck();
    });

    // If the timeout already elapsed while the tab was hidden, re-check as
    // soon as focus returns instead of waiting for the next chat event.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            scheduleIdleCheck();
        } else {
            clearIdleTimer();
        }
    });
}

function addSettingsUI() {
    const settings = getSettings();
    const html = `
    <div class="proactive-messaging-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Proactive Messaging</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="pm_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>Enable proactive messaging</span>
                </label>
                <label>
                    <span>Idle time before follow-up (seconds)</span>
                    <input id="pm_idle_seconds" type="number" min="5" max="600" value="${settings.idleSeconds}" />
                </label>
                <label>
                    <span>Messages needed to count as "flowing"</span>
                    <input id="pm_min_messages" type="number" min="1" max="50" value="${settings.minRecentMessages}" />
                </label>
                <label>
                    <span>Flow window (seconds)</span>
                    <input id="pm_flow_window" type="number" min="10" max="3600" value="${settings.flowingWindowSeconds}" />
                </label>
                <label>
                    <span>Cooldown between auto follow-ups (seconds)</span>
                    <input id="pm_cooldown" type="number" min="10" max="3600" value="${settings.cooldownSeconds}" />
                </label>
                <label class="checkbox_label">
                    <input id="pm_require_focus" type="checkbox" ${settings.requireTabFocused ? 'checked' : ''} />
                    <span>Only trigger while this tab is focused ("online")</span>
                </label>
                <small>
                    Type <code>/proactive-test</code> in chat to fire a check immediately (still
                    respects the flow and cooldown settings, but skips the idle timer).
                </small>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    const { saveSettingsDebounced } = SillyTavern.getContext();

    $('#pm_enabled').on('change', function () {
        const s = getSettings();
        s.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        if (s.enabled) scheduleIdleCheck();
        else clearIdleTimer();
    });
    $('#pm_idle_seconds').on('change', function () {
        getSettings().idleSeconds = Number($(this).val()) || defaultSettings.idleSeconds;
        saveSettingsDebounced();
    });
    $('#pm_min_messages').on('change', function () {
        getSettings().minRecentMessages = Number($(this).val()) || defaultSettings.minRecentMessages;
        saveSettingsDebounced();
    });
    $('#pm_flow_window').on('change', function () {
        getSettings().flowingWindowSeconds = Number($(this).val()) || defaultSettings.flowingWindowSeconds;
        saveSettingsDebounced();
    });
    $('#pm_cooldown').on('change', function () {
        getSettings().cooldownSeconds = Number($(this).val()) || defaultSettings.cooldownSeconds;
        saveSettingsDebounced();
    });
    $('#pm_require_focus').on('change', function () {
        getSettings().requireTabFocused = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

function registerDebugCommand() {
    try {
        const context = SillyTavern.getContext();
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'proactive-test',
            callback: async () => {
                await tryTriggerProactiveMessage();
                return '';
            },
            helpString: 'Manually runs the Proactive Messaging idle-check right now (still respects the flow and cooldown settings, but skips waiting for the idle timer).',
        }));
    } catch (error) {
        console.error(`[${MODULE_NAME}] Could not register /proactive-test:`, error);
    }
}

jQuery(() => {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, () => {
        addSettingsUI();
        bindEvents();
        registerDebugCommand();
        scheduleIdleCheck();
        log('loaded');
    });
});
