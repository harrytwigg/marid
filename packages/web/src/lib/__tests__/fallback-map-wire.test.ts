import { describe, expect, it } from 'vitest'
import {
  blankSourceProblem,
  malformedSourceProblem,
  malformedTargetProblem,
  mapNotAMappingProblem,
  modelMapEntryPath,
  modelMapPath,
  targetNotAModelIdProblem,
  unservedTargetProblem,
  unservedTargetWarning,
} from '@hundredfold/fallback-map-wire'
import { mapPairProblem, type ServedModels } from '@/routes/settings/engines/model-map-model'

/* The bundle reaches the gateway's own problem strings, byte for byte.
 *
 * The sentences are pinned to hard-coded literals rather than to a call back into
 * the module, and that is the whole point: `packages/hundredfold`'s engine-fallback.test.ts
 * hard-codes the same sentences against the config loader. Both suites passing is
 * what proves the editor refuses a map entry in the words the loader would use. If
 * one side ever drifts, exactly one of the two suites goes red.
 *
 * The last case in each group closes the remaining gap: that the editor picks the
 * RIGHT sentence for an entry, not merely that the right sentence exists. A literal
 * cannot say that, so those compare the editor's verdict against the wire directly. */

describe('fallbackModelMap problem strings', () => {
  it('names the config path an operator would edit', () => {
    expect(modelMapPath('claude')).toBe('engines.claude.fallbackModelMap')
    expect(modelMapEntryPath('claude', 'claude-opus-5')).toBe('engines.claude.fallbackModelMap["claude-opus-5"]')
  })

  it('reports a map that is not a mapping, in the loader words', () => {
    expect(mapNotAMappingProblem('codex', ['haiku']))
      .toBe('engines.codex.fallbackModelMap must be a mapping of model id to model id (got array)')
    expect(mapNotAMappingProblem('codex', 'haiku'))
      .toBe('engines.codex.fallbackModelMap must be a mapping of model id to model id (got string)')
    // `typeof null` is "object", so null gets named rather than mislabelled.
    expect(mapNotAMappingProblem('codex', null))
      .toBe('engines.codex.fallbackModelMap must be a mapping of model id to model id (got null)')
  })

  it('reports a blank source and a target that is not a model id, in the loader words', () => {
    expect(blankSourceProblem('claude')).toBe('engines.claude.fallbackModelMap has a blank model id as a key')
    expect(targetNotAModelIdProblem('claude', 'opus', 3))
      .toBe('engines.claude.fallbackModelMap["opus"] must be a nonempty model id (got number)')
    expect(targetNotAModelIdProblem('claude', 'opus', '  '))
      .toBe('engines.claude.fallbackModelMap["opus"] must be a nonempty model id (got string)')
  })

  it('reports a key and a target carrying a control character, in the loader words', () => {
    expect(malformedSourceProblem('antigravity', 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)')).toBe(
      'engines.antigravity.fallbackModelMap has a key that is not a model id '
      + '(got "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)")',
    )
    expect(malformedTargetProblem('claude', 'claude-opus-5', 'gpt-5.6-sol\tGPT-5.6 Sol')).toBe(
      'engines.claude.fallbackModelMap["claude-opus-5"] must be a model id with no control characters '
      + '(got "gpt-5.6-sol\\tGPT-5.6 Sol")',
    )
  })

  it('is the sentence the editor renders for the same entry, byte for byte', () => {
    const pastedKey = 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)'
    const served: ServedModels = { antigravity: ['gemini-3.7-flash-high'], codex: ['gpt-5.6-sol'] }
    const context = { engine: 'antigravity', substitute: 'codex', served }

    expect(mapPairProblem(context, [[pastedKey, 'gpt-5.6-sol']], 0))
      .toBe(malformedSourceProblem('antigravity', pastedKey))
    expect(mapPairProblem(context, [['gemini-3.7-flash-high', 'gpt-5.6-sol\tGPT-5.6 Sol']], 0))
      .toBe(malformedTargetProblem('antigravity', 'gemini-3.7-flash-high', 'gpt-5.6-sol\tGPT-5.6 Sol'))
  })

  it('reports a target the substitute does not serve — the one the editor renders', () => {
    const entry = { engine: 'claude', model: 'claude-opus-5', target: 'gpt-5.6-sol', substitute: 'grok' }

    expect(unservedTargetProblem(entry)).toBe(
      'engines.claude.fallbackModelMap["claude-opus-5"] maps to "gpt-5.6-sol", which engine "grok" does not serve',
    )
    // The runtime says the same thing and then what it did about it.
    expect(unservedTargetWarning(entry)).toBe(
      `${unservedTargetProblem(entry)} — running grok on its own default model instead.`,
    )
  })
})
