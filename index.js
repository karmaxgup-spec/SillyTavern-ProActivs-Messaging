// Strip Emojis - SillyTavern extension
// Removes emojis from AI responses once a message is received.
// Uses SillyTavern.getContext(), so no relative import paths are needed.

(() => {
    const MODULE = 'strip_emojis';
    const DEFAULTS = Object.freeze({
        enabled: true,
        stripReasoning: true,
    });

    // One pictographic character, excluding (c) (R) (TM), which are text symbols.
    const PICT = '(?![\\u00A9\\u00AE\\u2122])\\p{Extended_Pictographic}';

    // An emoji "sequence": a base emoji plus variation selectors, skin tones,
    // keycap marks, tag characters, and ZWJ-joined emojis. Flags are pairs of
    // regional indicators. ZWJ is only removed when it joins emojis, so scripts
    // that legitimately use it (Persian, Indic) are left alone.
    const EMOJI_RE = new RegExp(
        `(?:${PICT}|[\\u{1F1E6}-\\u{1F1FF}]{1,2})` +
        `(?:[\\uFE0F\\u{1F3FB}-\\u{1F3FF}\\u20E3\\u{E0020}-\\u{E007F}]|\\u200D${PICT})*` +
        `|[\\uFE0F\\u20E3\\u{1F3FB}-\\u{1F3FF}]`,
        'gu',
    );

    function stripEmojis(text) {
        if (typeof text !== 'string' || !text) return text;
        const out = text.replace(EMOJI_RE, '');
        if (out === text) return text;
        // Tidy leftover spacing where an emoji was removed.
        return out.replace(/(\S) {2,}/g, '$1 ').replace(/[ \t]+$/gm, '');
    }

    function getSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE]) {
            extensionSettings[MODULE] = { ...DEFAULTS };
        }
        for (const key of Object.keys(DEFAULTS)) {
            if (!Object.hasOwn(extensionSettings[MODULE], key)) {
                extensionSettings[MODULE][key] = DEFAULTS[key];
            }
        }
        return extensionSettings[MODULE];
    }

    // Returns true if anything in the message changed.
    function cleanMessage(msg, settings) {
        if (!msg || msg.is_user || msg.is_system) return false;
        let changed = false;

        const apply = (obj, key) => {
            const next = stripEmojis(obj[key]);
            if (next !== obj[key]) {
                obj[key] = next;
                changed = true;
            }
        };

        apply(msg, 'mes');
        if (Array.isArray(msg.swipes)) {
            for (let i = 0; i < msg.swipes.length; i++) apply(msg.swipes, i);
        }
        if (settings.stripReasoning && msg.extra && typeof msg.extra.reasoning === 'string') {
            apply(msg.extra, 'reasoning');
        }
        return changed;
    }

    async function processMessage(messageId) {
        const settings = getSettings();
        if (!settings.enabled) return;

        const context = SillyTavern.getContext();
        const msg = context.chat[messageId];
        if (!cleanMessage(msg, settings)) return;

        try {
            context.updateMessageBlock(messageId, msg);
            await context.saveChat();
        } catch (err) {
            console.warn('[Strip Emojis] Failed to refresh/save message', err);
        }
    }

    async function cleanWholeChat() {
        const settings = getSettings();
        const context = SillyTavern.getContext();
        let count = 0;

        context.chat.forEach((msg, id) => {
            if (cleanMessage(msg, settings)) {
                context.updateMessageBlock(id, msg);
                count++;
            }
        });

        if (count > 0) await context.saveChat();
        toastr.info(`Cleaned ${count} message${count === 1 ? '' : 's'}.`, 'Strip Emojis');
    }

    function addSettingsUI() {
        const settings = getSettings();
        const html = `
        <div class="strip-emojis-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Strip Emojis</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="strip_emojis_enabled">
                        <input type="checkbox" id="strip_emojis_enabled" />
                        <span>Remove emojis from AI responses</span>
                    </label>
                    <label class="checkbox_label" for="strip_emojis_reasoning">
                        <input type="checkbox" id="strip_emojis_reasoning" />
                        <span>Also remove from reasoning blocks</span>
                    </label>
                    <div id="strip_emojis_clean" class="menu_button">Clean current chat</div>
                    <small>Emojis may show briefly while a reply streams, then get removed when it finishes.</small>
                </div>
            </div>
        </div>`;

        $('#extensions_settings2').append(html);

        $('#strip_emojis_enabled')
            .prop('checked', settings.enabled)
            .on('input', function () {
                settings.enabled = !!$(this).prop('checked');
                SillyTavern.getContext().saveSettingsDebounced();
            });

        $('#strip_emojis_reasoning')
            .prop('checked', settings.stripReasoning)
            .on('input', function () {
                settings.stripReasoning = !!$(this).prop('checked');
                SillyTavern.getContext().saveSettingsDebounced();
            });

        $('#strip_emojis_clean').on('click', cleanWholeChat);
    }

    jQuery(() => {
        const { eventSource, event_types } = SillyTavern.getContext();

        addSettingsUI();

        // Fires for every AI reply (streamed or not), after the text is complete.
        eventSource.on(event_types.MESSAGE_RECEIVED, processMessage);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, processMessage);
        eventSource.on(event_types.MESSAGE_SWIPED, processMessage);

        console.log('[Strip Emojis] loaded');
    });
})();
