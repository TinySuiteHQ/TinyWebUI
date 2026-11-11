<script setup lang="ts">
/** One tool: a switch, its name and first line; open, its description, parameters and raw schema. */
import { computed } from 'vue';

// A tool from /api/tools, read field by field.
type Json = any;
const props = defineProps<{ tool: Json, readOnly: boolean, defaultApproval: string }>();
const emit = defineEmits<{ toggle: [disabled: boolean], approval: [policy: string] }>();

const short = computed(() => props.tool.name.replace(/^[^_]+__/, ''));
const params = computed(() => Object.entries(props.tool.parameters?.properties || {}) as [string, Json][]);
const required = (key: string) => (props.tool.parameters?.required || []).includes(key);
// Descriptions are often hard-wrapped, so a first line can stop mid-sentence.
// The summary is the first paragraph joined into one line; CSS ends it with
// an ellipsis where it runs out of room.
const lead = (text: unknown) => (typeof text === 'string' ? text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ') : '');
</script>

<template>
  <details class="tool" :class="{ off: tool.disabled }">
    <summary>
      <!-- A click inside a <summary> toggles the details; the controls stop it from getting there. -->
      <label class="tgl" @click.stop><input type="checkbox" :checked="!tool.disabled" :disabled="readOnly"
             :title="tool.disabled ? 'Disabled: click to let the model use this tool again' : 'Click to stop offering this tool to the model'"
             @change="emit('toggle', !($event.target as HTMLInputElement).checked)"></label>
      <span class="name">{{ short }}</span>
      <span class="desc">{{ lead(tool.description) }}</span>
      <!-- MCP tools only: built-ins never ask, so they have no approval state. -->
      <select v-if="tool.approval" class="approval" title="Whether calls to this tool wait for your approval" :value="tool.approval"
              :disabled="readOnly" @click.stop @change="emit('approval', ($event.target as HTMLSelectElement).value)">
        <option value="default">approval: {{ defaultApproval }}</option>
        <option value="ask">approval: always ask</option>
        <option value="auto">approval: never ask</option>
      </select>
    </summary>
    <div class="doc">
      {{ tool.description || '(no description)' }}
      <div v-if="params.length" class="params">
        <div v-for="[key, spec] in params" :key="key" class="param">
          <b>{{ key }}</b><span class="ty">{{ spec.type || (spec.anyOf ? 'any' : '?') }}</span>
          <span :class="required(key) ? 'req' : 'ty'">{{ required(key) ? 'required' : 'optional' }}</span>
          <span class="d">{{ lead(spec.description) }}</span>
        </div>
      </div>
      <pre>{{ JSON.stringify(tool.parameters ?? {}, null, 2) }}</pre>
    </div>
  </details>
</template>
