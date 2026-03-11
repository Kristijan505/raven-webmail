<script lang="ts">
  export let codeMode: boolean;

  import type { EditorContext } from "./SignatureEditor.svelte";
  const { all, any, cmd, has } = getContext("editor") as EditorContext;

  import Bold from "~icons/mdi/format-bold";
  import Underline from "~icons/mdi/format-underline";
  import Italic from "~icons/mdi/format-italic";
  import JustifyLeft from "~icons/mdi/format-align-left";
  import JustifyRight from "~icons/mdi/format-align-right";
  import JustifyCenter from "~icons/mdi/format-align-center";
  import ListBulleted from "~icons/mdi/format-list-bulleted";
  import ListNumbered from "~icons/mdi/format-list-numbered";
  import Undo from "~icons/mdi/undo";
  import Redo from "~icons/mdi/redo";
  import RemoveFormat from "~icons/mdi/format-clear";
  import Xml from "~icons/mdi/xml";

  import FontSize from "./FontSize.svelte";
  import FontFamily from "./FontFamily.svelte";
  import Color from "./Color.svelte";

  import { tooltip } from "$lib/actions";
  import { getContext } from "svelte";
  import { _message } from "$lib/Notify/notify";
  import { locale } from "$lib/locale";
</script>

<style>
  
  x-toolbar {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  x-commands {
    display: flex;
    flex-direction: row; 
    align-items: center;
    padding: 0 0.5em;
    box-shadow: rgba(0,0,0,0.35) 0 1px 3px 2px;
    border-radius: 0.25rem;
    margin: 0.5rem 1rem 0.75rem 0.75rem;
    overflow-x: auto;
    overflow-y: hidden;
  }

  x-commands::-webkit-scrollbar {
    height: 2px;
  } 

  x-toolbar :global(x-command-group) {
    display: flex;
    align-items: center;
    flex-direction: row;
    padding: 0 0.25em;
    flex: none;
  }

  x-toolbar :global(x-command) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 0.1em;
    user-select: none;
    cursor: pointer;
    color: #444;
    transition: background-color 300ms ease, color 300ms ease;
    border-radius: 3px;
    position: relative;
    flex: none;
  }

  x-toolbar :global(x-command:hover),
  x-toolbar :global(x-command.hover) {
    color: #111;
    background-color: rgba(0,0,0,0.15);
  }

  x-toolbar :global(x-command:active) {
    background-color: rgba(0,0,0,0.25);
  }

  x-toolbar :global(x-command.multiple:after) {
    content: "▼";
    transform: scaleY(0.6); 
    font-size: 0.8em;
  }

  /*
  x-toolbar :global(x-command-group + x-command-group) {
    border-inline-start: rgba(0,0,0,0.1) 1px solid;
  }
  */

  x-toolbar :global(x-command-group:empty) {
    display: none;
  }

  x-toolbar :global(x-command > svg) {
    font-size: 1.4em;
  }
  
</style>

<x-toolbar>

  <x-commands class="elev3 thin-scroll">
    {#if all("undo", "redo")}
      <x-command-group>
        <x-command use:tooltip={$locale.Undo} on:click={() => cmd("undo")}>
          <Undo />
        </x-command>
        <x-command use:tooltip={$locale.Redo} on:click={() => cmd("redo")}>
          <Redo />
        </x-command>
      </x-command-group>
    {/if}

    {#if !codeMode}
      {#if has("fontName")}
        <x-command-group>
          <FontFamily label={$locale.Font_type} />
        </x-command-group>
      {/if}

      {#if has("fontSize")}
        <x-command-group>
          <FontSize label={$locale.Font_size}/>
        </x-command-group>
      {/if}
      
      {#if any("bold", "italic", "underline")}
        <x-command-group>
          {#if has("bold")}
            <x-command use:tooltip={$locale.Bold} on:click={() => cmd("bold")}>
              <Bold />
            </x-command>
          {/if}

          {#if has("italic")}
            <x-command use:tooltip={$locale.Italic} on:click={() => cmd("italic")}>
              <Italic />
            </x-command>
          {/if}

          {#if has("underline")}
            <x-command use:tooltip={$locale.Underline} on:click={() => cmd("underline")}>
              <Underline />
            </x-command>
          {/if}
        </x-command-group>
      {/if}

      {#if any("foreColor", "backColor")}
        <Color />
      {/if}

      {#if any("justifyLeft", "justifyCenter", "justifyRight")}
        <x-command-group>
          {#if has("justifyLeft")}
            <x-command use:tooltip={$locale.Align_left} on:click={() => cmd("justifyLeft")}>
              <JustifyLeft />
            </x-command>
          {/if}
          {#if has("justifyCenter")}
            <x-command use:tooltip={$locale.Align_center} on:click={() => cmd("justifyCenter")}>
              <JustifyCenter />
            </x-command>
          {/if}
          {#if has("justifyRight")}
            <x-command use:tooltip={$locale.Align_right} on:click={() => cmd("justifyRight")}>
              <JustifyRight />
            </x-command>
          {/if}
        </x-command-group>
      {/if}

      {#if any("insertUnorderedList", "insertOrderedList")}
        <x-command-group>
          {#if has("insertUnorderedList")}
            <x-command use:tooltip={$locale.List} on:click={() => cmd("insertUnorderedList")}>
              <ListBulleted />
            </x-command>
          {/if}
          {#if has("insertOrderedList")}
            <x-command use:tooltip={$locale.Numbered_list} on:click={() => cmd("insertOrderedList")}>
              <ListNumbered />
            </x-command>
          {/if}
        </x-command-group>
      {/if}

      {#if has("removeFormat")}
        <x-command-group>
          <x-command use:tooltip={$locale.Remove_format} on:click={() => cmd("removeFormat")}>
            <RemoveFormat />
          </x-command>
        </x-command-group>
      {/if}
    {/if}

    <x-command-group>
      <x-command use:tooltip={$locale.Toggle_code_view} on:click={() => codeMode = !codeMode}>
        <Xml />
      </x-command>
    </x-command-group>
  </x-commands>
</x-toolbar>
