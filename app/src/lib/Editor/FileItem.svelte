<script lang="ts">
  export let file: MessageFile;
  export let onRemove: () => void;

  import Error from "~icons/mdi/alert-circle";
  import Success from "~icons/mdi/check-circle-outline";
  import Remove from "~icons/mdi/close";  
  import { url } from "$lib/fileIcons";
  import { quadOut } from "svelte/easing"; 
  import Ripple from "$lib/Ripple.svelte";
  import { tooltip } from "$lib/actions";
  import { fileError, fileLoaded, fileState } from "$lib/Compose/compose";
  import type { MessageFile } from "$lib/Compose/compose";
import { locale } from "$lib/locale";

  const out = (node: HTMLElement, params: any) => {
    const h = node.clientHeight;
    return {
      easing: quadOut,
      ...params,
      css: (t: number, u: number) => {
        return `z-index: var(--z-base); margin-top: -${u * h}px; opacity: ${t};`
      }
    }
  }
</script>

<style>
  x-file {
    position: relative;
    min-width: auto;
    z-index: var(--z-raised);
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
    align-content: center;
    padding: 0.5em 0;
    flex: none;
    background: var(--surface);
  }

  x-file:not(:only-child) {
    border-bottom: var(--border-gray) 1px solid;
  }

  x-icon {
    flex: none;
    width: 3em;
    height: 3em;
    background: var(--surface-2);
    border-radius: 3px;
    margin-inline-end: 1em;
    position: relative;
  }

  x-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-inline-end: 1em;
    flex: 1;
  }

  x-progress {
    background-color: var(--red);
    position: absolute;
    height: 3px;
    left: 0;
    bottom: 0;
    transition: width var(--duration) ease; 
  }

  x-state {
    font-size: 1.5em;
    border-radius: var(--radius-full);
    display: flex;
    flex: none;
    padding: 0.25em;
  }

  .complete {
    color: var(--color-success);
  }

  .error {
    color: var(--color-error);
  }

  .remove {
    border-radius: var(--radius-full);
    padding: 0.75em;
    display: flex;
    flex: none;
  }

  .remove:before {
    top: 50%;
    left: -1em;
    transform: translate(-100%, -50%);
  }
</style>


<x-file out:out|local={{duration: 150}}>
  <x-icon>
    <img src={url(file.filename)} alt="" width="100%" height="100%">
  </x-icon>
  <x-name>{file.filename}</x-name>
  {#if file[fileState] === "uploading"}
    <x-progress style="width: {(file[fileLoaded] / file.size) * 100}%"></x-progress>
  {:else if file[fileState] === "complete" || file[fileState] == null}
    <x-state class="complete">
      <Success />
    </x-state>
  {:else if file[fileState] === "error"}
    <x-state class="error" use:tooltip={file[fileError]}>
      <Error />
    </x-state>
  {/if}
  <x-action class="remove btn-dark" use:tooltip={$locale.Remove} on:click={onRemove}>
    <Remove />
    <Ripple />
  </x-action>
</x-file>
