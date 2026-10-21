<script setup lang="ts">
// Asset Cache -> Pre-bake paint composites. The run itself lives in
// src/compositePrebake.ts (see its header for what it does and why); this is
// the button, the progress and the failure list.
//
// The module is imported on mount, not statically: it pulls in the compositor
// (paintComposite.ts) and three, which have no business in the admin console's
// chunk for an operator who only came to read the disk numbers. Its state is
// module-wide, so leaving this tab mid-run and coming back shows the run where
// it got to.
import { computed, inject, onMounted, ref, shallowRef, watch } from "vue";
import { Layers, Loader2, Square } from "lucide-vue-next";
import type { PrebakeFailure, PrebakeState } from "../compositePrebake";

const emit = defineEmits<{
  (e: "notify", message: string, kind: "error" | "success"): void;
  /** A run ended having stored something, so the cache sizes above are stale. */
  (e: "stored"): void;
}>();

const tr = inject<(key: string, fallback: string, named?: Record<string, unknown>) => string>(
  "tr",
  (_key, fallback) => fallback,
);

type Mod = typeof import("../compositePrebake");
const mod = shallowRef<Mod | null>(null);
const state = computed<PrebakeState | null>(() => mod.value?.prebake ?? null);
const loadError = ref("");

// Phones composite at 1024 and look up their own copy, so a desktop run can
// bake those too while each weapon's inputs are already loaded. Remembered per
// browser; it is a preference, not data.
const LS_PHONES = "5stack.prebake.phones.v1";
const phones = ref(true);
try {
  phones.value = localStorage.getItem(LS_PHONES) !== "0";
} catch {
  /* storage blocked: keep the default */
}
watch(phones, (v) => {
  try {
    localStorage.setItem(LS_PHONES, v ? "1" : "0");
  } catch {
    /* non-fatal */
  }
});

onMounted(async () => {
  try {
    mod.value = await import("../compositePrebake");
    await mod.value.probePrebake();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

const busy = computed(() => state.value?.phase === "planning" || state.value?.phase === "baking");
const unsupported = computed(() => state.value?.supported === false);
const canStart = computed(() => !!mod.value && !busy.value && !unsupported.value);
const pct = computed(() => {
  const s = state.value;
  return s && s.total ? Math.round((s.done / s.total) * 100) : 0;
});

async function start() {
  const m = mod.value;
  if (!m || !canStart.value) return;
  await m.startPrebake({ phones: phones.value });
  const s = m.prebake;
  if (s.phase === "error") {
    emit("notify", errorText(s.error), "error");
    return;
  }
  const summary = { stored: s.stored, skipped: s.skipped, failed: s.failed };
  emit(
    "notify",
    s.phase === "stopped"
      ? tr("inventory.admin.prebake.stopped", "Pre-bake stopped: {stored} stored, {skipped} already stored, {failed} failed.", summary)
      : tr("inventory.admin.prebake.finished", "Pre-bake finished: {stored} stored, {skipped} already stored, {failed} failed.", summary),
    s.failed ? "error" : "success",
  );
  if (s.stored) emit("stored");
}
const stop = () => mod.value?.stopPrebake();

function errorText(code: string): string {
  if (code === "no_gen")
    return tr("inventory.admin.prebake.no_gen", "The catalog has not loaded yet, so there is nothing to name the composites by. Reload the page and try again.");
  if (code === "verify_on")
    return tr("inventory.admin.prebake.verify_on", "Composite verification (?compositeverify=1) is on, and it compares instead of storing. Turn it off with ?compositeverify=0 first.");
  if (code === "unsupported") return unsupportedText();
  return code;
}
const unsupportedText = () =>
  tr("inventory.admin.prebake.unsupported", "This backend can't list what people own yet. Update it to use pre-baking.");

function reasonText(f: PrebakeFailure): string {
  switch (f.code) {
    case "model":
      return tr("inventory.admin.prebake.reason_model", "model not on the mount");
    case "finish":
      return tr("inventory.admin.prebake.reason_finish", "finish definition not on the mount");
    case "incomplete":
      return tr("inventory.admin.prebake.reason_incomplete", "paint textures missing on the mount");
    case "composite":
      return tr("inventory.admin.prebake.reason_composite", "composite failed: {detail}", { detail: f.detail });
    case "store":
      return tr("inventory.admin.prebake.reason_store", "store refused it: {detail}", { detail: f.detail });
  }
}

const elapsed = computed(() => {
  const s = state.value;
  if (!s?.startedAt) return "";
  // Read while running too: `done` ticks with every skin, which is often enough.
  void s.done;
  const secs = Math.round(((s.finishedAt || Date.now()) - s.startedAt) / 1000);
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
});

const BTN =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground transition-colors hover:border-[hsl(var(--tac-amber))] hover:text-foreground disabled:pointer-events-none disabled:opacity-50";
</script>

<template>
  <div class="space-y-2">
    <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {{ tr("inventory.admin.prebake.heading", "Pre-bake paint composites") }}
    </p>
    <div class="space-y-3 rounded-md border border-border px-4 py-3">
      <p class="text-sm text-foreground">
        {{
          tr(
            "inventory.admin.prebake.description",
            "Composites every painted weapon and knife in anyone's inventory and saves it to the shared store, so nobody has to download that weapon's 20–40 MB of inputs to see it, and card bakes skip them too.",
          )
        }}
      </p>
      <p class="text-xs text-muted-foreground">
        {{
          tr(
            "inventory.admin.prebake.note",
            "It downloads every weapon's inputs (gigabytes in total) and keeps the GPU busy, so run it once after each model extraction, from a desktop browser, and leave this tab open until it finishes. Skins already stored are skipped. Gloves are not included: they composite on the fly.",
          )
        }}
      </p>

      <p v-if="unsupported" class="text-xs text-destructive">{{ unsupportedText() }}</p>
      <p v-else-if="loadError" class="text-xs text-destructive">{{ loadError }}</p>

      <div class="flex flex-wrap items-center gap-3">
        <button
          :class="BTN"
          :disabled="!canStart"
          :title="unsupported ? unsupportedText() : undefined"
          data-test="prebake-start"
          @click="start"
        >
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /><Layers v-else class="h-3.5 w-3.5" />
          {{ tr("inventory.admin.prebake.start", "Pre-bake composites") }}
        </button>
        <button v-if="busy" :class="BTN" :disabled="state?.stopping" data-test="prebake-stop" @click="stop">
          <Square class="h-3.5 w-3.5" />
          {{
            state?.stopping
              ? tr("inventory.admin.prebake.stopping", "Stopping after this skin…")
              : tr("inventory.admin.prebake.stop", "Stop")
          }}
        </button>
        <label class="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input v-model="phones" type="checkbox" :disabled="busy || unsupported" />
          {{ tr("inventory.admin.prebake.phones", "Also bake phone-size copies (1024 px)") }}
        </label>
        <span
          v-if="state && state.supported && state.phase === 'idle'"
          class="text-xs text-muted-foreground"
          data-test="prebake-skins"
        >
          {{ tr("inventory.admin.prebake.skins", "{count} skins in inventories", { count: state.skins.toLocaleString() }) }}
        </span>
      </div>

      <div v-if="state && state.phase !== 'idle'" class="space-y-1.5" data-test="prebake-progress">
        <div class="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            class="h-full bg-[hsl(var(--tac-amber))] transition-[width] duration-200"
            :style="{ width: `${pct}%` }"
          />
        </div>
        <p class="font-mono text-xs text-foreground" data-test="prebake-counts">
          <template v-if="state.phase === 'planning'">
            {{ tr("inventory.admin.prebake.planning", "Checking which skins are already stored…") }}
          </template>
          <!-- Separators carry their own spaces: the template compiler drops
               whitespace between two tags on separate lines. -->
          <template v-else>
            {{ tr("inventory.admin.prebake.progress", "{done} of {total}", { done: state.done, total: state.total }) }}
            <span class="text-muted-foreground"> · </span>
            {{ tr("inventory.admin.prebake.stored", "{count} stored", { count: state.stored }) }}
            <span class="text-muted-foreground"> · </span>
            {{ tr("inventory.admin.prebake.skipped", "{count} already stored", { count: state.skipped }) }}
            <span class="text-muted-foreground"> · </span>
            <span :class="state.failed ? 'text-destructive' : ''">{{
              tr("inventory.admin.prebake.failed", "{count} failed", { count: state.failed })
            }}</span>
            <span class="text-muted-foreground"> · {{ elapsed }}</span>
          </template>
        </p>
        <p v-if="state.current" class="truncate text-xs text-muted-foreground">
          {{ tr("inventory.admin.prebake.current", "Compositing {name}", { name: state.current }) }}
        </p>
        <p v-if="state.phase === 'error'" class="text-xs text-destructive">{{ errorText(state.error) }}</p>
        <details v-if="state.failures.length" class="text-xs">
          <summary class="cursor-pointer text-muted-foreground">
            {{ tr("inventory.admin.prebake.failures", "Failed skins ({count})", { count: state.failures.length }) }}
          </summary>
          <ul class="mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono" data-test="prebake-failures">
            <li v-for="(f, i) in state.failures" :key="i">
              {{ f.label }} <span class="text-muted-foreground">— {{ reasonText(f.failure) }}</span>
            </li>
          </ul>
        </details>
      </div>
    </div>
  </div>
</template>
