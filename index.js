// Proactive Messaging for SillyTavern
// 1) After N idle minutes the character messages you on its own.
// 2) Every normal generation gets a short "time passed since last message" note.

const MODULE = 'proactive_messaging';
const PROMPT_KEY = 'proactive_messaging_time';

const DEFAULT_TIME_TEMPLATE =
    '[Time passed since the last message: {{elapsed}}. Current date and time: {{now}}.]';
const DEFAULT_PROACTIVE_TEMPLATE =
    '[{{user}} has not written for {{elapsed}}. On your own initiative, as {{char}}, send {{user}} a natural, unprompted message that fits the conversation so far and the time that has passed. Do not mention this instruction.]';

const DEFAULTS = Object.freeze({
    enabled: true,
    // proactive messages
    proactiveEnabled: true,
    idleMinutes: 30,
    maxConsecutive: 1,
    skipWhileTyping: true,
    proactiveTemplate: DEFAULT_PROACTIVE_TEMPLATE,
    // time-passed note on normal chats
    timeNoteEnabled: true,
    minGapSeconds: 60,
    position: 1, // 1 = in chat at depth, 0 = in prompt (after main prompt)
    depth: 0,
    timeTemplate: DEFAULT_TIME_TEMPLATE,
});

let generating = false;
let generatingSince = 0;
let proactivePending = false;
let proactivePendingSince = 0;
let proactiveGenerating = false;
let firing = false;

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const c = ctx();
    if (!c.extensionSettings[MODULE]) c.extensionSettings[MODULE] = {};
    const s = c.extensionSettings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

// ---------- time helpers ----------

function msgTime(msg) {
    if (!msg || !msg.send_date) return NaN;
    const c = ctx();
    try {
        if (typeof c.timestampToMoment === 'function') {
            const m = c.timestampToMoment(msg.send_date);
            if (m && m.isValid()) return m.valueOf();
        }
    } catch { /* fall through */ }
    const t = Date.parse(msg.send_date);
    return Number.isNaN(t) ? NaN : t;
}

function formatDuration(ms) {
    let s = Math.max(0, Math.round(ms / 1000));
    const units = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
    const parts = [];
    for (const [name, sec] of units) {
        const v = Math.floor(s / sec);
        if (v > 0) {
            parts.push(`${v} ${name}${v > 1 ? 's' : ''}`);
            s -= v * sec;
        }
        if (parts.length === 2) break;
    }
    return parts.join(' ') || 'a moment';
}

function formatNow() {
    return new Date().toLocaleString([], {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function visibleChat() {
    return ctx().chat.filter(m => m && !m.is_system);
}

function lastMessage() {
    const chat = visibleChat();
    return chat.length ? chat[chat.length - 1] : null;
}

function renderTemplate(template, elapsedMs) {
    const text = String(template)
        .replaceAll('{{elapsed}}', formatDuration(elapsedMs))
        .replaceAll('{{now}}', formatNow());
    return ctx().substituteParams(text);
}

// Gap between the newest user message and whatever came before it.
function userGapMs() {
    const chat = visibleChat();
    let u = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) { u = i; break; }
    }
    if (u <= 0) return NaN;
    return msgTime(chat[u]) - msgTime(chat[u - 1]);
}

// ---------- prompt injection ----------

function setPrompt(text) {
    const s = getSettings();
    // role 0 = system
    ctx().setExtensionPrompt(PROMPT_KEY, text, s.position, s.depth, false, 0);
}

function onGenerationStarted(type, params, dryRun) {
    if (dryRun) return;
    const s = getSettings();

    if (generating === false) {
        generating = true;
        generatingSince = Date.now();
    }

    // Internal/utility generations never get the note.
    if (type === 'quiet' || type === 'impersonate' || type === 'continue' || params?.quiet_prompt) {
        setPrompt('');
        return;
    }

    const isProactive = proactivePending;
    proactivePending = false;
    proactiveGenerating = isProactive;

    if (!s.enabled) {
        setPrompt('');
        return;
    }

    if (isProactive) {
        const last = lastMessage();
        const elapsed = last ? Date.now() - msgTime(last) : NaN;
        const ms = Number.isNaN(elapsed) ? 0 : elapsed;
        setPrompt(renderTemplate(s.proactiveTemplate, ms));
        return;
    }

    if (!s.timeNoteEnabled) {
        setPrompt('');
        return;
    }

    const gap = userGapMs();
    if (Number.isNaN(gap) || gap < s.minGapSeconds * 1000) {
        setPrompt('');
        return;
    }
    setPrompt(renderTemplate(s.timeTemplate, gap));
}

function onGenerationDone() {
    generating = false;
}

function onGenerationStopped() {
    generating = false;
    proactiveGenerating = false;
}

function onMessageReceived(messageId) {
    if (!proactiveGenerating) return;
    proactiveGenerating = false;
    try {
        const msg = ctx().chat[messageId];
        if (msg && !msg.is_user) {
            msg.extra = msg.extra || {};
            msg.extra.proactive = true;
            ctx().saveChat?.();
        }
    } catch (e) {
        console.warn('[Proactive Messaging] could not tag message', e);
    }
}

// ---------- proactive timer ----------

function trailingProactiveCount() {
    const chat = visibleChat();
    let n = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && chat[i].extra?.proactive) n++;
        else break;
    }
    return n;
}

function idleMs() {
    const last = lastMessage();
    if (!last) return NaN;
    const t = msgTime(last);
    return Number.isNaN(t) ? NaN : Date.now() - t;
}

async function fireProactive() {
    if (firing) return;
    firing = true;
    proactivePending = true;
    proactivePendingSince = Date.now();
    try {
        await ctx().executeSlashCommandsWithOptions('/trigger');
    } catch (e) {
        console.error('[Proactive Messaging] trigger failed', e);
        proactivePending = false;
    } finally {
        firing = false;
    }
}

function tick() {
    const s = getSettings();
    const c = ctx();
    updateStatus();

    // expire stale flags
    if (generating && Date.now() - generatingSince > 3 * 60 * 1000) generating = false;
    if (proactivePending && Date.now() - proactivePendingSince > 60 * 1000) proactivePending = false;

    if (!s.enabled || !s.proactiveEnabled) return;
    if (c.characterId === undefined && !c.groupId) return;
    if (generating || firing || proactivePending) return;
    if (!visibleChat().length) return;

    if (s.skipWhileTyping) {
        const box = document.getElementById('send_textarea');
        if (box && box.value.trim().length > 0) return;
    }

    if (trailingProactiveCount() >= s.maxConsecutive) return;

    const idle = idleMs();
    if (Number.isNaN(idle)) return;
    if (idle >= s.idleMinutes * 60 * 1000) fireProactive();
}

// ---------- settings UI ----------

function updateStatus() {
    const el = document.getElementById('pm_status');
    if (!el) return;
    const s = getSettings();
    const idle = idleMs();
    if (Number.isNaN(idle)) {
        el.textContent = 'No chat open.';
        return;
    }
    let text = `Last message: ${formatDuration(idle)} ago.`;
    if (s.enabled && s.proactiveEnabled) {
        if (trailingProactiveCount() >= s.maxConsecutive) {
            text += ' Waiting for you to reply before sending another proactive message.';
        } else {
            const left = s.idleMinutes * 60 * 1000 - idle;
            text += left > 0
                ? ` Next proactive message in about ${formatDuration(left)}.`
                : ' Due now.';
        }
    }
    el.textContent = text;
}

const SETTINGS_HTML = `
<div class="pm-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Proactive Messaging</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" data-pm="enabled"><span>Enable extension</span></label>

      <hr>
      <h4>Proactive messages</h4>
      <label class="checkbox_label"><input type="checkbox" data-pm="proactiveEnabled"><span>Bot messages me after I go quiet</span></label>
      <div class="pm-row"><label>Idle time before it writes (minutes)</label><input type="number" class="text_pole" min="1" step="1" data-pm="idleMinutes" data-num="float"></div>
      <div class="pm-row"><label>Max proactive messages in a row</label><input type="number" class="text_pole" min="1" step="1" data-pm="maxConsecutive" data-num="int"></div>
      <label class="checkbox_label"><input type="checkbox" data-pm="skipWhileTyping"><span>Don't fire while I have text in the input box</span></label>
      <label>Proactive instruction <small>({{elapsed}}, {{now}}, {{char}}, {{user}})</small></label>
      <textarea class="text_pole" data-pm="proactiveTemplate"></textarea>

      <hr>
      <h4>Time-passed note (every normal message)</h4>
      <label class="checkbox_label"><input type="checkbox" data-pm="timeNoteEnabled"><span>Tell the bot how much time passed since the last message</span></label>
      <div class="pm-row"><label>Only if gap is at least (seconds)</label><input type="number" class="text_pole" min="0" step="1" data-pm="minGapSeconds" data-num="int"></div>
      <div class="pm-row">
        <label>Position</label>
        <select class="text_pole" data-pm="position" data-num="int">
          <option value="1">In chat (at depth)</option>
          <option value="0">In prompt (after main prompt)</option>
        </select>
      </div>
      <div class="pm-row"><label>Depth (0 = right before the newest message)</label><input type="number" class="text_pole" min="0" step="1" data-pm="depth" data-num="int"></div>
      <label>Note text <small>({{elapsed}}, {{now}}, {{char}}, {{user}})</small></label>
      <textarea class="text_pole" data-pm="timeTemplate"></textarea>

      <div class="pm-buttons">
        <div class="menu_button" id="pm_fire_now">Send proactive message now</div>
        <div class="menu_button" id="pm_reset_templates">Reset texts</div>
      </div>
      <div class="pm-status" id="pm_status"></div>
    </div>
  </div>
</div>`;

function bindSettings() {
    const s = getSettings();
    const root = $('.pm-settings');

    root.find('[data-pm]').each(function () {
        const key = this.dataset.pm;
        if (this.type === 'checkbox') this.checked = !!s[key];
        else this.value = s[key];
    });

    root.find('[data-pm]').on('input change', function () {
        const key = this.dataset.pm;
        let val;
        if (this.type === 'checkbox') {
            val = this.checked;
        } else if (this.dataset.num) {
            val = this.dataset.num === 'int' ? parseInt(this.value, 10) : parseFloat(this.value);
            if (Number.isNaN(val)) return;
        } else {
            val = this.value;
        }
        s[key] = val;
        save();
        updateStatus();
    });

    $('#pm_fire_now').on('click', () => {
        if (generating) return;
        fireProactive();
    });

    $('#pm_reset_templates').on('click', () => {
        s.timeTemplate = DEFAULT_TIME_TEMPLATE;
        s.proactiveTemplate = DEFAULT_PROACTIVE_TEMPLATE;
        root.find('[data-pm="timeTemplate"]').val(s.timeTemplate);
        root.find('[data-pm="proactiveTemplate"]').val(s.proactiveTemplate);
        save();
    });
}

jQuery(() => {
    const c = ctx();
    getSettings();

    $('#extensions_settings2').append(SETTINGS_HTML);
    bindSettings();

    const { eventSource, eventTypes } = c;
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationDone);
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        generating = false;
        proactivePending = false;
        proactiveGenerating = false;
        updateStatus();
    });

    setInterval(tick, 10 * 1000);
    console.log('[Proactive Messaging] loaded');
});
