<script lang="ts">
  import TextField from "./TextField.svelte";
  
  import VisibilityOn from "~icons/mdi/eye";
  import VisibilityOff from "~icons/mdi/eye-off";

  export let value: string = "";
  export let textFieldProps: Record<string, any> = {};
  export let visible: boolean = false;
  export let label: string | undefined = void 0;
  export let id: string | undefined = void 0;
  export let name: string | undefined = void 0;

  $: textFieldProps.type = visible ? "text" : "password";
  $: label != null && (textFieldProps.label = label);

  // prevent keyboard
  export const toggle = () => (visible = !visible);
</script>

<style>
  .password {
    position: relative;
  }

  .icon {
    position: absolute;
    right: 0;
    top: 0;
    width: 2em;
    height: 100%;
    cursor: pointer;
    color: var(--text-muted);
    transition: color var(--duration) ease;
    display: flex;
    font-size: 1.5em;
    user-select: none;
    align-items: center;
    justify-content: center;
  }

  .icon:hover {
    color: var(--text);
  }
</style>

<div class="password">
  <TextField
    {...textFieldProps}
    bind:value
    {id}
    {name}
    on:input
    on:focus
    on:blur
    on:change />
  <div
    class="icon"
    on:mousedown|preventDefault
    on:click|preventDefault={toggle}>
    {#if visible}
      <VisibilityOn />
    {:else}
      <VisibilityOff />
    {/if}
  </div>
</div>
