<script setup lang="ts">
// A Sticker Craft in 3D, before using it — opened from a craft tile's picture in
// the sticker picker (Mine or the Craft Store).
//
// The single-sticker preview's own viewer, given a group: the same quad model,
// camera, framing, studio light and slow turn, with the craft laid on one
// larger sheet of its stickers' backing (ViewerOpts.decalGroup in viewer3d).
// Under it: how many stickers it takes, its votes when it is a store craft,
// and Use.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowBigDown, ArrowBigUp, Loader2, X } from "lucide-vue-next";
import { Z } from "../zLayers";
import { useViewerMount } from "../composables/useViewerMount";
import { QUAD_MODELS } from "../viewerModel";
import type { SavedCraft, StoreCraft } from "../stickerCraftsModel";

const props = defineProps<{
  craft: SavedCraft | StoreCraft;
  /** It fits the gun (or the mat) — Use is off otherwise. */
  fits: boolean;
  /** How many stickers fit, for the reason Use is off. */
  room: number;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "use"): void;
  (e: "vote", v: -1 | 1): void;
}>();

const store = computed(() => ("author" in props.craft ? (props.craft as StoreCraft) : null));
const stageEl = ref<HTMLElement | null>(null);
const failed = ref<string | null>(null);
const viewer = useViewerMount({
  label: "craft preview",
  host: () => stageEl.value,
  onError: (e) => (failed.value = e instanceof Error ? e.message : String(e)),
});
const busy = viewer.busy;
// The single-sticker preview's own options (openPreview3d in App.vue), with
// the craft in place of one decal.
onMounted(() =>
  viewer.mount(QUAD_MODELS.sticker, () => ({
    kind: "sticker",
    decalGroup: props.craft.stickers.map((s) => ({ image: s.image, wear: s.wear, x: s.x, y: s.y, rot: s.rot })),
    frame: "fit",
    interactive: false,
  })),
);
onBeforeUnmount(() => viewer.teardown());

const n = computed(() => props.craft.stickers.length);
</script>

<template>
  <div
    class="fixed inset-0 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
    :style="{ zIndex: Z.previewStage }"
    role="dialog"
    aria-modal="true"
    :aria-label="craft.name"
    @click.self="emit('close')"
  >
    <div class="flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
      <div class="flex items-center gap-2 border-b border-border px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="truncate text-f11 uppercase tracking-cs1">{{ craft.name }}</div>
          <div v-if="store" class="mt-0.5 flex items-center gap-1.5 text-f10 text-muted-foreground">
            <img v-if="store.author.avatar" :src="store.author.avatar" alt="" class="h-4 w-4 rounded-full object-cover" />
            <span v-else class="grid h-4 w-4 place-items-center rounded-full bg-secondary text-f8 uppercase">{{ store.author.name.slice(0, 1) }}</span>
            <span class="truncate">{{ store.author.name }}</span>
          </div>
        </div>
        <button
          class="flex h-7 w-7 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          title="Close"
          @click="emit('close')"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
      <!-- The single-sticker preview's stage, wider: a craft is a strip. The
           viewer paints its own studio backdrop. -->
      <div class="relative aspect-[4/3] w-full bg-background">
        <div ref="stageEl" class="absolute inset-0" />
        <div v-if="busy" class="pointer-events-none absolute inset-0 grid place-items-center">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="failed" class="absolute inset-0 grid place-items-center p-6 text-center text-f11 text-destructive">
          The 3D view could not start. {{ failed }}
        </div>
      </div>
      <div class="flex items-center gap-3 border-t border-border px-3 py-2">
        <span class="font-mono text-f9 uppercase tracking-cs1 text-muted-foreground">
          {{ n }} {{ n === 1 ? "sticker" : "stickers" }}
        </span>
        <!-- Votes: a store craft only, and never your own. -->
        <div v-if="store" class="flex items-center gap-0.5">
          <button
            class="grid h-7 w-7 place-items-center rounded transition-colors disabled:opacity-35"
            :class="store.myVote === 1 ? 'text-[#7ee08a]' : 'text-muted-foreground hover:text-foreground'"
            :disabled="store.mine"
            :title="store.mine ? 'Your craft' : store.myVote === 1 ? 'Take your upvote back' : 'Upvote'"
            @click="emit('vote', 1)"
          ><ArrowBigUp class="h-4 w-4" /></button>
          <span class="min-w-[2ch] text-center font-mono text-f11" :title="`${store.ups} up · ${store.downs} down`">{{ store.score }}</span>
          <button
            class="grid h-7 w-7 place-items-center rounded transition-colors disabled:opacity-35"
            :class="store.myVote === -1 ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'"
            :disabled="store.mine"
            :title="store.mine ? 'Your craft' : store.myVote === -1 ? 'Take your downvote back' : 'Downvote'"
            @click="emit('vote', -1)"
          ><ArrowBigDown class="h-4 w-4" /></button>
        </div>
        <button
          class="tac-action tac-on ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-f10 uppercase tracking-cs1 disabled:opacity-35"
          :disabled="!fits"
          :title="fits ? 'Use this craft' : `Needs ${n} free sticker slots — there ${room === 1 ? 'is' : 'are'} ${room}`"
          @click="emit('use')"
        >
          Use this craft
        </button>
      </div>
    </div>
  </div>
</template>
