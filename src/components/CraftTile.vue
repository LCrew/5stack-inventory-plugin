<script setup lang="ts">
// One Sticker Craft in the sticker picker's Sticker Crafts tab — yours (Mine)
// or a published one (the Craft Store).
//
// Not one big button like a sticker tile: a craft is looked at before it is
// used. The picture opens it in 3D (CraftPreview), Use puts it on the gun, and a
// store craft carries its author and its votes in between. A craft with more
// stickers than the gun has room for stays visible but can't be used, and says
// why.
import { computed } from "vue";
import { ArrowBigDown, ArrowBigUp, Box } from "lucide-vue-next";
import type { SavedCraft, StoreCraft } from "../stickerCraftsModel";

const props = defineProps<{
  craft: SavedCraft | StoreCraft;
  fits: boolean;
  /** Picture height, from the picker's card-size slider. */
  size: number;
  /** One of your own crafts that is in the store. */
  published?: boolean;
}>();
const emit = defineEmits<{
  (e: "preview"): void;
  (e: "use"): void;
  (e: "vote", v: -1 | 1): void;
}>();

const store = computed(() => ("author" in props.craft ? (props.craft as StoreCraft) : null));
const n = computed(() => props.craft.stickers.length);
const shortName = (name: string) => name.replace(/^Sticker \| /, "");
</script>

<template>
  <div
    class="group relative flex flex-col gap-1 overflow-hidden rounded-md border border-border bg-background p-1.5 transition-colors"
    :class="fits ? 'hover:border-[color:var(--acc)]' : 'opacity-45'"
  >
    <div class="flex items-center gap-1.5 text-f8 uppercase tracking-cs1 text-muted-foreground/70">
      <span class="truncate">Sticker craft · {{ n }} {{ n === 1 ? "sticker" : "stickers" }}</span>
      <span v-if="!fits" class="ml-auto flex-none text-destructive/80">Needs {{ n }} free slots</span>
      <span v-else-if="published" class="ml-auto flex-none text-[#9fcbff]">Public</span>
    </div>
    <!-- The picture is the way into 3D. -->
    <button
      class="relative w-full overflow-hidden rounded bg-[#183a31]"
      :style="{ height: size + 'px' }"
      :title="'Look at ' + craft.name + ' in 3D — ' + craft.stickers.map((s) => shortName(s.name)).join(', ')"
      @click="emit('preview')"
    >
      <img
        v-if="craft.preview"
        :src="craft.preview"
        alt=""
        class="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-105"
        draggable="false"
      />
      <!-- No picture yet (saved before pictures, and the board not opened
           since): the stickers themselves, in slot order. -->
      <div v-else class="flex h-full flex-wrap items-center justify-center gap-1 p-1">
        <img v-for="(s, si) in craft.stickers" :key="si" :src="s.image" alt="" class="h-8 w-8 object-contain" />
      </div>
      <span class="absolute right-1 top-1 hidden items-center justify-center rounded border border-border bg-background/90 p-1 text-muted-foreground group-hover:flex">
        <Box class="h-3.5 w-3.5" />
      </span>
    </button>
    <div class="truncate text-center text-f10 text-foreground">{{ craft.name }}</div>
    <div v-if="store" class="flex items-center gap-1.5 text-f9 text-muted-foreground">
      <img v-if="store.author.avatar" :src="store.author.avatar" alt="" class="h-4 w-4 flex-none rounded-full object-cover" />
      <span v-else class="grid h-4 w-4 flex-none place-items-center rounded-full bg-secondary text-f8 uppercase">{{ store.author.name.slice(0, 1) }}</span>
      <span class="min-w-0 truncate">{{ store.author.name }}</span>
      <span class="ml-auto flex flex-none items-center">
        <button
          class="grid h-5 w-5 place-items-center rounded transition-colors disabled:opacity-35"
          :class="store.myVote === 1 ? 'text-[#7ee08a]' : 'hover:text-foreground'"
          :disabled="store.mine"
          :title="store.mine ? 'Your craft' : store.myVote === 1 ? 'Take your upvote back' : 'Upvote'"
          @click="emit('vote', 1)"
        ><ArrowBigUp class="h-3.5 w-3.5" /></button>
        <span class="min-w-[2ch] text-center font-mono text-f10" :title="`${store.ups} up · ${store.downs} down`">{{ store.score }}</span>
        <button
          class="grid h-5 w-5 place-items-center rounded transition-colors disabled:opacity-35"
          :class="store.myVote === -1 ? 'text-destructive' : 'hover:text-foreground'"
          :disabled="store.mine"
          :title="store.mine ? 'Your craft' : store.myVote === -1 ? 'Take your downvote back' : 'Downvote'"
          @click="emit('vote', -1)"
        ><ArrowBigDown class="h-3.5 w-3.5" /></button>
      </span>
    </div>
    <button
      class="tac-action rounded border border-border py-1 text-f9 uppercase tracking-cs1 text-muted-foreground disabled:pointer-events-none"
      :disabled="!fits"
      :title="fits ? 'Use this craft' : `Needs ${n} free sticker slots`"
      @click="emit('use')"
    >Use</button>
  </div>
</template>
