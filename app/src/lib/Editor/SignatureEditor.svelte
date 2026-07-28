<script lang="ts" context="module">
  export type EditorContext = {
    cmd: (name: string, value?: any) => boolean
    has: (name: string) => boolean
    any: (...name: string[]) => boolean
    all: (...name: string[]) => boolean 
    _document: Writable<Document | null>
    _window: Writable<Window | null>
  };
</script>

<script lang="ts">
  export let html: string;
  export let onChange: ((html: string) => void) | null = null;
  export let onDirty: (() => void) | null = null;

  let codeMode = false;

  const _document = writable<Document | null>(null);
  const _window = writable<Window | null>(null);
  const has = (cmd: string) => document.queryCommandSupported(cmd);
  const cmd = (key: string, value?: any) => $_document?.execCommand(key, null, value);
  const any = (...cmds: string[]) => cmds.some(c => has(c));
  const all = (...cmds: string[]) => cmds.every(c => has(c));
  
  const context = {
    _document, _window, has, cmd, any, all
  }

  setContext("editor", context);

  import css from "./iframe.css?raw";
  import { proxyRemoteImages, serializeEditorBody } from "$lib/actions";
  import { setContext } from "svelte";
  import { writable } from "svelte/store";
  import type { Writable } from "svelte/store";
  import SignatureBar from "./SignatureBar.svelte";
	import CodeEditor from "./CodeEditor.svelte";
  
  const contents = (node: HTMLElement) => {
    
    const iframe = document.createElement("iframe");
  
    // No allow-forms — see Editor.svelte. contentEditable does not need it, and this
    // document renders stored signature HTML.
    iframe.setAttribute("sandbox", "allow-same-origin");
    iframe.srcdoc = "<!doctype html><html><head></head><body></body></html>";

    let obs: MutationObserver | null = null;

    node.appendChild(iframe);

    Promise.resolve().then(async () => {
      await new Promise(resolve => iframe.onload = resolve);
      
      const _document = iframe.contentDocument;
      const _window = iframe.contentWindow;

      context._document.set(_document);
      context._window.set(_window);

      _document.documentElement.classList.add("editor-content");

      const style = _document.createElement("style");
      style.textContent = css;
      _document.head.appendChild(style);

      _document.body.contentEditable = "true";
      // Sandboxed (no allow-scripts) iframe: sanitize so scripts / inline event
      // handlers / nested srcdoc-iframes in a saved signature are stripped instead
      // of being blocked by the sandbox and logged to the console. Keeps
      // formatting, inline styles and (base64) images.
      _document.body.innerHTML = proxyRemoteImages(html);
      
      // Assigned to the OUTER `obs`, not redeclared: a `const obs` here shadows it, so
      // the disconnect in destroy() below would forever see null and the observer would
      // outlive the editor. Every compose open leaks one otherwise.
      obs = new MutationObserver(() => {
        html = serializeEditorBody(_document.body);
        onChange?.(html);
      });

      obs.observe(_document.body, {
        childList: true,
        characterData: true,
        attributes: true,
        subtree: true,
      });

      // `input` fires only on real user editing (typing, paste, toolbar
      // execCommand) — not on the programmatic load above — so it's a clean
      // "the user touched the signature" signal for the unsaved-changes guard.
      _document.body.addEventListener("input", () => onDirty?.());
    })

    return {
      destroy: () => {
        node.removeChild(iframe);
        obs?.disconnect();
      },
    }
  }
</script>

<style>
  .editor {
    flex-grow: 1;
    display: flex;
    flex-direction: column;  
  }  

  .code {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .contents {
    flex: 1;
  }

  .contents > :global(iframe) {
    border: 0;
    padding: 0;
    margin: 0;
    outline: 0;
    width: 100%;
    height: 100%;
  }
</style>

<div class="editor">
  {#if !codeMode}
    <div class="contents" use:contents>

    </div>
  {:else}
    <div class="code">
      <CodeEditor bind:html {onChange} {onDirty} />
    </div>
  {/if}
  
  <div class="bar">
    <SignatureBar bind:codeMode />
  </div>
</div>
