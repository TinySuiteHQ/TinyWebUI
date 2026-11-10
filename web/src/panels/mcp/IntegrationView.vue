<script setup lang="ts">
/**
 * One management view of an MCP server, read from `base` (its .../views/<id>
 * URL): stats, or a table with filters, paging, an open row and actions. The
 * admin panel's oversight shows other people's views through this too; they
 * arrive without actions, so none is drawn.
 *
 * Everything here is plain data drawn as text. A server never supplies markup
 * or script, only values, so a hostile one can at worst show odd text.
 */
import { onMounted, reactive, ref, watch } from 'vue';
import Icon from '../../ui/Icon.vue';
import { api } from '../../core/api.ts';

// A view manifest and its data, as the server relays them, read field by field.
type Json = any;
const props = defineProps<{ view: Json, base: string }>();

const enc = encodeURIComponent;
const query = reactive<Record<string, string>>({});
const offset = ref(0);
const data = ref<Json | null>(null);
const error = ref('');
const loading = ref(false);
const detail = ref<Json | null>(null); // { fields, row } while a row is open
const detailLoading = ref(false);
const editing = ref<{ action: Json, row: Json | null, value: string } | null>(null);
const actionError = ref<{ id: string, message: string } | null>(null);
const busyAction = ref('');
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function format(value: unknown, fmt?: string) {
  if (value === null || value === undefined || value === '') return '—';
  if (fmt === 'datetime') {
    const d = new Date(value as string);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }
  if (fmt === 'number' && typeof value === 'number') return value.toLocaleString();
  return String(value);
}

async function load() {
  const mine = ++seq;
  detail.value = null;
  editing.value = null;
  loading.value = true;
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v));
  if (props.view.kind === 'table') params.set('offset', String(offset.value));
  try {
    const out = await api.get(`${props.base}?${params}`);
    if (mine !== seq) return;
    data.value = out;
    error.value = '';
  } catch (err) {
    if (mine === seq) error.value = err.message || String(err);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function setParam(name: string, value: string, debounce = false) {
  clearTimeout(timer);
  const go = () => { query[name] = value.trim(); offset.value = 0; load(); };
  // Each keystroke would otherwise be a round trip to the server.
  if (debounce) timer = setTimeout(go, 300); else go();
}

async function openRow(row: Json) {
  const v = props.view;
  if (!v.hasDetail && !v.actions.some((a: Json) => a.target === 'row')) return;
  const mine = ++seq;
  detail.value = { fields: v.columns.map((c: Json) => ({ label: c.label, value: row[c.key], format: c.format })), row };
  if (v.hasDetail && v.rowKey && row[v.rowKey] !== null) {
    detailLoading.value = true;
    try {
      const out = await api.get(`${props.base}/items/${enc(String(row[v.rowKey]))}`);
      if (mine === seq) detail.value = { ...out, row: out.row || row };
    } catch (err) {
      if (mine === seq) { detail.value = null; error.value = err.message; }
    } finally {
      if (mine === seq) detailLoading.value = false;
    }
  }
}

function startAction(action: Json, row: Json | null) {
  actionError.value = null;
  if (!action.input) { run(action, row, null); return; }
  editing.value = { action, row, value: action.input.initial && row ? String(row[action.input.initial] ?? '') : '' };
}

async function run(action: Json, row: Json | null, input: string | null) {
  // The server refuses a destructive action without this; the page's part is
  // making sure a person actually said yes.
  if (action.destructive && !window.confirm(action.confirm || `${action.label}? This cannot be undone.`)) return;
  busyAction.value = action.id;
  try {
    const res = await api.post(`${props.base}/actions/${enc(action.id)}`, {
      row: row || undefined, input: input ?? undefined, confirm: action.destructive ? true : undefined
    });
    if (!res.ok) throw new Error(res.message || 'The server refused.');
    editing.value = null;
    await load();
  } catch (err) {
    actionError.value = { id: action.id, message: err.message };
  } finally {
    busyAction.value = '';
  }
}

const viewActions = () => props.view.actions.filter((a: Json) => a.target === 'view');
const rowActions = () => props.view.actions.filter((a: Json) => a.target === 'row');
const clickable = () => props.view.hasDetail || rowActions().length;

onMounted(load);
watch(() => props.base, () => { for (const k of Object.keys(query)) delete query[k]; offset.value = 0; load(); });
</script>

<template>
  <div class="int-view">
    <p v-if="error" class="int-error">{{ error }}</p>
    <p v-else-if="!data && loading" class="empty">Loading…</p>
    <template v-else-if="data && view.kind === 'stats'">
      <p v-if="data.notice" class="int-notice">{{ data.notice }}</p>
      <div class="int-stats">
        <div v-for="(item, i) in data.items" :key="i" class="int-stat">
          <span class="int-stat-label">{{ item.label }}</span>
          <span class="int-stat-value">{{ item.unit && format(item.value, item.format) !== '—' ? `${format(item.value, item.format)} ${item.unit}` : format(item.value, item.format) }}</span>
          <span v-if="item.hint" class="usage">{{ item.hint }}</span>
        </div>
      </div>
    </template>
    <template v-else-if="data && detail">
      <button type="button" class="int-back-row with-icon" @click="load"><Icon name="arrowLeft" />Back to the list</button>
      <div class="int-detail">
        <p v-if="detailLoading" class="empty">Loading…</p>
        <template v-else>
          <dl class="int-fields">
            <template v-for="(f, i) in detail.fields" :key="i">
              <dt>{{ f.label }}</dt><dd :class="{ multiline: f.format === 'multiline' }">{{ format(f.value, f.format) }}</dd>
            </template>
          </dl>
          <div class="int-actions">
            <button v-for="a in rowActions()" :key="a.id" type="button" :class="{ danger: a.destructive }" :disabled="busyAction === a.id"
                    @click="startAction(a, detail.row)">{{ a.label }}</button>
          </div>
          <p v-if="actionError" class="int-error">{{ actionError.message }}</p>
          <form v-if="editing" class="int-edit" @submit.prevent="run(editing.action, editing.row, editing.value)">
            <label :for="`int-input-${editing.action.id}`">{{ editing.action.input.label }}</label>
            <textarea v-if="editing.action.input.multiline" :id="`int-input-${editing.action.id}`" v-model="editing.value" rows="6"
                      :maxlength="editing.action.input.maxLength" required />
            <input v-else :id="`int-input-${editing.action.id}`" v-model="editing.value" type="text" :maxlength="editing.action.input.maxLength" required>
            <div class="int-actions">
              <button type="submit" class="primary">Save</button>
              <button type="button" @click="editing = null">Cancel</button>
            </div>
          </form>
        </template>
      </div>
    </template>
    <template v-else-if="data">
      <div v-if="view.params.length || viewActions().length" class="int-filters">
        <div v-for="param in view.params" :key="param.name" class="int-field">
          <label :for="`int-${param.name}`">{{ param.label }}</label>
          <select v-if="param.type === 'enum'" :id="`int-${param.name}`" :value="query[param.name] || ''"
                  @change="setParam(param.name, ($event.target as HTMLSelectElement).value)">
            <option value="">Any</option>
            <option v-for="v in param.values" :key="v" :value="v">{{ v }}</option>
          </select>
          <input v-else :id="`int-${param.name}`" type="search" :maxlength="param.maxLength" :value="query[param.name] || ''"
                 @input="setParam(param.name, ($event.target as HTMLInputElement).value, true)">
        </div>
        <button v-for="a in viewActions()" :key="a.id" type="button" :class="{ danger: a.destructive }" :disabled="busyAction === a.id"
                @click="startAction(a, null)">{{ a.label }}</button>
      </div>
      <p v-if="actionError && !detail" class="int-error">{{ actionError.message }}</p>
      <form v-if="editing && !editing.row" class="int-edit" @submit.prevent="run(editing.action, null, editing.value)">
        <label :for="`int-input-${editing.action.id}`">{{ editing.action.input.label }}</label>
        <textarea v-if="editing.action.input.multiline" :id="`int-input-${editing.action.id}`" v-model="editing.value" rows="6" required />
        <input v-else :id="`int-input-${editing.action.id}`" v-model="editing.value" type="text" required>
        <div class="int-actions"><button type="submit" class="primary">Save</button><button type="button" @click="editing = null">Cancel</button></div>
      </form>
      <p v-if="data.notice" class="int-notice">{{ data.notice }}</p>
      <p v-if="!data.rows.length" class="empty">{{ offset ? 'No more rows.' : 'Nothing here yet.' }}</p>
      <table v-else class="int-table">
        <thead><tr><th v-for="c in view.columns" :key="c.key" :class="{ num: c.format === 'number' }">{{ c.label }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in data.rows" :key="i" :class="{ 'int-row': clickable() }" :tabindex="clickable() ? 0 : undefined"
              @click="openRow(row)" @keydown.enter="openRow(row)">
            <td v-for="c in view.columns" :key="c.key" :class="{ num: c.format === 'number' }">{{ format(row[c.key], c.format) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="int-pager">
        <span class="usage">{{ data.rows.length ? `${(offset + 1).toLocaleString()}–${(offset + data.rows.length).toLocaleString()}${data.total !== null ? ` of ${data.total.toLocaleString()}` : ''}` : '' }}</span>
        <button type="button" class="with-icon" :disabled="offset === 0" @click="offset = Math.max(0, offset - view.pageSize); load()"><Icon name="chevronLeft" />Previous</button>
        <button type="button" class="with-icon" :disabled="!data.hasMore" @click="offset += data.rows.length || view.pageSize; load()">Next<Icon name="chevronRight" /></button>
      </div>
    </template>
  </div>
</template>
