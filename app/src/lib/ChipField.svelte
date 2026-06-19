<script lang="ts">
  export let id = String(Math.random()).slice(2);
  export let currentText: string = "";
  export let value: string[] = [];
  export let map: (v: string) => string | false = (v) => v;
  export let accept: (v: string) => boolean = () => true;
  export let errorMessage: string | null = null;
  export let label: string | undefined;
  export let validate: boolean = false;
  export let required: boolean = false;

  export const removeIndex = (i: number) => {
    const helper = value.slice()
    helper.splice(i, 1);
    value = helper;
  }

  import Close from "~icons/mdi/close";

  const keypress = (event: KeyboardEvent) => {
    
    if(event.key !== "Enter") return;

    try {
      let v: string | false = currentText;
      v = map(v);
      if(v !== false) {
        if(accept(v)) {
          value = [...value, v];
          currentText = "";
        }
      }
    } catch(e) {
      errorMessage = e.message;
    }
  }

  import ValidationError from "./Formy/ValidationError.svelte";
  import TextField from "./TextField.svelte";
  import { getContext, onMount } from "svelte";
  import { locale } from "$lib/locale";



  let validationError: string | null = null;
  export let doValidate = () => {
    if(validate && required && value.length === 0) {
      validationError = $locale.validation.Field_required;
      return false;
    }

    return true;
  }
  
  import type Context from "./Formy/Formy.svelte";
  const formy = getContext("formy") as Context | undefined;
  onMount(() => formy && formy.register(doValidate));

</script>

<style>
  .field {
    position: relative;
  }

  .chips {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    margin-bottom: var(--space-1);
  }

  .chip {
    border-radius: 1000px;
    display: flex;
    flex-direction: row;
    flex: none;
    align-items: center;
    background: var(--surface-2);
    margin: 0 var(--space-3) var(--space-3) 0;
  }

  .chip-txt {
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  }

  .remove {
    border-radius: var(--radius-full);
    display: flex;
    color: #dfdfdf;
    background: rgba(0,0,0,0.3);
    font-size: 1.5rem;
    margin: var(--space-1) var(--space-1) var(--space-1) 0;
  }
</style>

<div class="chipfield">

  {#if value.length}
    <slot name="chips">
      <div class="chips">
        {#each value as chip, i }
          <div class="chip">
            <div class="chip-txt">
              {chip}
            </div>
            <div class="remove btn-dark" on:click={() => removeIndex(i)}>
              <Close />
            </div>
          </div>
        {/each}
      </div> 
    </slot>
  {/if}

  <div class="field">
    <TextField 
      {id}
      bind:value={currentText}
      on:keypress={keypress}
      on:keypress
      on:input
      on:input={() => errorMessage = validationError = null}
      on:focus={() => errorMessage = validationError = null}
      on:click={() => errorMessage = validationError = null}
      {label}
    />
    {#if validationError}
      <ValidationError attrFor={id} message={validationError} />
    {:else if errorMessage}
      <ValidationError attrFor={id} message={errorMessage} />
    {/if}
  </div>

</div>
