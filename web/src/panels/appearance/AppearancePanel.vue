<script setup lang="ts">
/** Appearance: the theme, for this person and (for an admin) everyone's default. */
import { computed } from 'vue';
import { useTheme } from '../../stores/theme.ts';
import { PANEL } from '../../stores/panels.ts';
import { usePanel } from '../usePanel.ts';
import AppearanceSection from './AppearanceSection.vue';

const theme = useTheme();
const shown = computed(() => Boolean(theme.server && (theme.server.canChoose || (theme.server.multiUser && theme.server.canShare))));

// Re-read on open: an admin may have added or removed a theme since.
const { isOpen } = usePanel(PANEL.APPEARANCE, { onOpen: () => theme.load() });
</script>

<template>
  <section :id="PANEL.APPEARANCE" class="set-panel" :class="{ open: isOpen }" aria-label="Appearance">
    <div class="automation-head"><h2>Appearance</h2></div>
    <div class="settings-content">
      <AppearanceSection />
      <p v-if="!shown" class="empty">Your administrator sets the theme.</p>
    </div>
  </section>
</template>
