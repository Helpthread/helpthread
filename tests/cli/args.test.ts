import { describe, expect, it } from 'vitest'
import { ArgsError, parseInstallArgs, parseVerifyArgs } from '../../cli/src/args.js'

describe('parseInstallArgs', () => {
  it('parses the module slug alone', () => {
    expect(parseInstallArgs(['draft-assistant'])).toEqual({
      help: false,
      moduleSlug: 'draft-assistant',
      catalogOrigin: undefined,
      version: undefined,
      dir: undefined,
      force: false,
    })
  })

  it('parses every option', () => {
    expect(
      parseInstallArgs([
        'draft-assistant',
        '--catalog',
        'https://example.test',
        '--version',
        '0.2.0',
        '--dir',
        './somewhere',
        '--force',
      ]),
    ).toEqual({
      help: false,
      moduleSlug: 'draft-assistant',
      catalogOrigin: 'https://example.test',
      version: '0.2.0',
      dir: './somewhere',
      force: true,
    })
  })

  it('returns help for -h/--help without requiring a module slug', () => {
    expect(parseInstallArgs(['--help'])).toEqual({ help: true })
    expect(parseInstallArgs(['-h'])).toEqual({ help: true })
  })

  it('throws on a missing module slug', () => {
    expect(() => parseInstallArgs([])).toThrow(ArgsError)
    expect(() => parseInstallArgs(['--force'])).toThrow(/missing required argument/)
  })

  it('throws on an unknown option', () => {
    expect(() => parseInstallArgs(['draft-assistant', '--bogus'])).toThrow(/unknown option/)
  })

  it('throws on an extra positional argument', () => {
    expect(() => parseInstallArgs(['draft-assistant', 'kb-manager'])).toThrow(
      /unexpected extra argument/,
    )
  })

  it('throws when --catalog is missing its value', () => {
    expect(() => parseInstallArgs(['draft-assistant', '--catalog'])).toThrow(
      /--catalog requires a value/,
    )
  })
})

describe('parseVerifyArgs', () => {
  it('parses all required options', () => {
    expect(
      parseVerifyArgs(['a.tar.gz', '--manifest', 'a.manifest.json', '--signature', 'a.sig']),
    ).toEqual({
      help: false,
      tarballPath: 'a.tar.gz',
      manifestPath: 'a.manifest.json',
      signaturePath: 'a.sig',
    })
  })

  it('returns help without requiring other args', () => {
    expect(parseVerifyArgs(['--help'])).toEqual({ help: true })
  })

  it('throws when --manifest is missing', () => {
    expect(() => parseVerifyArgs(['a.tar.gz', '--signature', 'a.sig'])).toThrow(
      /missing required option: --manifest/,
    )
  })

  it('throws when --signature is missing', () => {
    expect(() => parseVerifyArgs(['a.tar.gz', '--manifest', 'a.manifest.json'])).toThrow(
      /missing required option: --signature/,
    )
  })

  it('throws when the tarball path is missing', () => {
    expect(() =>
      parseVerifyArgs(['--manifest', 'a.manifest.json', '--signature', 'a.sig']),
    ).toThrow(/missing required argument: <tarball>/)
  })
})
