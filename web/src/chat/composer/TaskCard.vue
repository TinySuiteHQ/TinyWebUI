<script setup lang="ts">
/**
 * The chat's checklist, as the model keeps it. A list that is all done folds
 * to its heading; the server drops it once the next question is asked.
 */
import { computed } from 'vue';
import { useChat } from '../../stores/chat.ts';
import Icon from '../../ui/Icon.vue';

const chat = useChat();
const tasks = computed(() => chat.model.tasks || []);
const done = computed(() => tasks.value.filter((t) => t.status === 'completed').length);
const MARK: Record<string, string> = { completed: 'check', in_progress: 'doing' };
</script>

<template>
  <details v-if="tasks.length" id="chatTasks" class="task-card" :open="done < tasks.length">
    <summary class="task-heading"><strong>Tasks</strong><span>{{ done }}/{{ tasks.length }}</span></summary>
    <ol class="task-items">
      <li v-for="(t, i) in tasks" :key="t.id || i" class="task-item" :class="`task-${t.status}`">
        <Icon class="task-mark" :name="MARK[t.status] || 'todo'" size=".95rem" /><span>{{ t.title }}</span>
      </li>
    </ol>
  </details>
</template>
