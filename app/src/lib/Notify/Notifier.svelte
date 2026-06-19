<svelte:options accessors={true} />

<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";

  import successIcon from "~icons/mdi/check-circle-outline";
  import errorIcon from "~icons/mdi/close-circle-outline";
  import infoIcon from "~icons/mdi/information-outline";
  import warningIcon from "~icons/mdi/alert-outline";
  import DOMPurify from "dompurify";

  const icons = {
    success: successIcon,
    error: errorIcon,
    info: infoIcon,
    warning: warningIcon,
  };

  type Variant = keyof typeof icons | "normal";

  type Message = {
    action?: {
      text: string;
      fn: (event: Event) => void;
    };
    icon?: typeof infoIcon;
    persist?: boolean;
    html?: string;
    text?: string;
    variant: Variant;
    duration: number;
  };

  export let messages: Message[] = [];
  export let maxStack: number = 3;
  export let duration: number = 3000;
  //export let variant = "normal";

  // messages[]
  // action?: {text: string, fn: (event) => void}
  // persist?: false
  // html?: html //or
  // text?: string
  // variant: "success" | "error" | "info" | "warning" | "normal"

  export const add = (src: Partial<Message> & { duration?: number }) => {
    let message: Message = {
      variant: src.variant || "normal",
      text: src.text,
      html: src.html,
      // @ts-ignore
      icon:
        src.icon ||
        (src.variant && src.variant !== "normal" ? icons[src.variant] : null),
      persist: !!src.persist,
      duration: src.duration || duration,
    };

    messages = [...messages, message];

    if (!message.persist) {
      setTimeout(() => remove(message), message.duration);
    }

    if (messages.length > maxStack) {
      messages = messages.slice(1);
    }
  };

  export const remove = (key: any) => {
    messages = messages.filter(message => message != key);
  };

  export const clear = () => {
    messages = [];
  };

  export const message = (text: string, message: Partial<Message> = {}) =>
    add({ variant: "normal", text, ...message });
  export const success = (text: string, message: Partial<Message> = {}) =>
    add({ variant: "success", text, ...message });
  export const info = (text: string, message: Partial<Message> = {}) =>
    add({ variant: "info", text, ...message });
  export const warn = (text: string, message: Partial<Message> = {}) =>
    add({ variant: "warning", text, ...message });
  export const error = (text: string, message: Partial<Message> = {}) =>
    add({ variant: "error", text, ...message });
</script>

<div class="messenger">
  {#each messages as message (message)}
    <div
      transition:fly={{ x: -200, duration: 250 }}
      animate:flip={{ duration: 200 }}
      class="message {message.variant}"
    >
      {#if message.icon}
        <div class="message-icon">
          <svelte:component this={message.icon} />
        </div>
      {/if}
      <div class="message-content {message.html != null ? 'html' : 'text'}">
        {#if message.html != null}
          {@html DOMPurify.sanitize(message.html)}
        {:else}
          {message.text}
        {/if}
      </div>

      {#if message.action}
        <div class="message-action">
          <button class="btn-light" on:click={(event) => message.action && message.action.fn(event)}>
            {message.action.text}
          </button>
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .messenger {
    position: fixed;
    z-index: var(--z-toast);
    bottom: 0.5em;
    left: 0.5em;
    display: flex;
    flex-direction: column-reverse;
    max-width: 80%;
  }

  .message {
    --icon-size: 1.25em;
    min-width: 250px;
    max-width: 400px;
    display: flex;
    flex-direction: row;
    padding: 0.5em 0.5em 0.5em 1em;
    color: var(--text);
    background-color: var(--surface);
    box-shadow: 0px 3px 5px -1px rgba(0, 0, 0, 0.2),
      0px 6px 10px 0px rgba(0, 0, 0, 0.14), 0px 1px 18px 0px rgba(0, 0, 0, 0.12);
    margin: 0.5em;
    border-radius: 0.25em;
  }

  /* Fixed, theme-agnostic toast colours (white text always readable on them);
     the adaptive --color-* tokens lighten in dark mode and would lose contrast. */
  .success {
    background-color: #43a047;
    color: #fff;
  }

  .error {
    background-color: #d32f2f;
    color: #fff;
  }

  .info {
    background-color: #1976d2;
    color: #fff;
  }

  .warning {
    background-color: #ffa000;
    color: #fff;
  }

  .message-icon {
    display: flex;
    flex: none;
    margin: auto 0;
    font-size: 1.5em;
    align-items: center;
    justify-content: center;
    height: 22px;
    width: 22px;
  }

  .message-content {
    padding: 0.25em 3em 0.25em 1em;
    line-height: 1.5em;
    margin: auto 0;
  }

  .message-content.text {
    white-space: pre-wrap;
  }

  .message-action {
    margin: auto 0 auto auto;
    flex: none;
  }
</style>
