<script lang="ts">
  export let value: boolean;
  export let id = String(Math.floor(Math.random() * (2**32)));
  export let label: string;
  export let compact: boolean = false;
  export let compactTop: boolean = compact;
  export let compactBottom: boolean = compact;
  export let onChange: ((v: boolean) => void) | undefined = void 0;
  export let readonly: boolean = false;
  export let required: boolean = false;
  export let validate: boolean = false;
  export let validationError: string | null = null;

  import { getContext, onMount } from "svelte";
  import { locale } from "$lib/locale";

  import Checkbox from "./Checkbox.svelte";
  import type { Context } from "./Formy/Formy.svelte";
  import ValidationError from "./Formy/ValidationError.svelte";
  import Ripple from "./Ripple.svelte";
  import Switch from "./Switch.svelte";
  
  export const doValidate = (): boolean => {
    if(!validate || !required) {
      validationError = null;
      return true;
    }

    if(!value) {
      validationError = $locale.validation.Field_required;
      console.log("[Formy] validation fails [BooleanField]", label, value)
      return false;
    }

    return true;
  }

  const formy = getContext("formy") as Context;
  onMount(() => formy && formy.register(doValidate));

  let lastValue = value;
  $: onValueChange(value)
  const onValueChange = (v: boolean) => {
    if(lastValue === v) return;
    lastValue = v;
    validationError = null;
    !readonly && onChange && onChange(v);
  }
</script>

<style>
  label {
    position: relative;
    display: flex;
    margin-inline-end: auto;
    flex-direction: row;
    align-items: center;
    font-size: 0.9rem;
    font-weight: 600;
    border-radius: var(--radius);
    padding: var(--space-1) var(--space-3) var(--space-1) var(--space-1);
    align-self: flex-start;
  }

  .compact-top {
    margin-top: calc(-1 * var(--space-2));
  }

  .compact-bottom {
    margin-bottom: calc(-1 * var(--space-2));
  }
</style>

<label for={id} class="boolean-field btn-dark" class:compact-top={compactTop} class:compact-bottom={compactBottom}>
  <Checkbox {readonly} bind:checked={value} {id} />
  {label}
  <Ripple />

  {#if validationError}
    <ValidationError message={validationError} on:click={() => validationError = null} />
  {/if}
</label>