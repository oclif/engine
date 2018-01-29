import {convertToCached} from '@dxcli/command'
import {ICachedCommand, ICLIConfig, ICommand, IConfig, IEngine, IPlugin, ITopic, read} from '@dxcli/config'
import cli from 'cli-ux'
import * as fs from 'fs-extra'
import * as globby from 'globby'
import * as _ from 'lodash'
import * as path from 'path'

import Cache from './cache'
import {registerTSNode} from './typescript'
import {undefault} from './util'

export interface LoadOptions {
  resetCache?: boolean
}

export default class Engine implements IEngine {
  public config: ICLIConfig
  private readonly _plugins: IPlugin[] = []
  private readonly _commands: ICachedCommand[] = []
  private readonly _topics: ITopic[] = []
  private readonly _hooks: {[k: string]: string[]} = {}
  private debug: any

  get plugins(): IPlugin[] { return this._plugins }
  get topics(): ITopic[] { return this._topics }
  get commands(): ICachedCommand[] { return this._commands }
  get commandIDs(): string[] { return this.commands.map(c => c.id) }
  get rootTopics(): ITopic[] { return this.topics.filter(t => !t.name.includes(':')) }
  get rootCommands(): ICachedCommand[] { return this.commands.filter(c => !c.id.includes(':')) }

  async load(config: IConfig, loadOptions: LoadOptions = {}) {
    this.config = {...config, engine: this}
    this.debug = require('debug')(['@dxcli/engine', this.config.name].join(':'))

    const loadPlugin = async (opts: {root: string, type: string, config?: IConfig, name?: string, tag?: string}) => {
      this.debug('loading plugin', opts.name || opts.root)
      const config = opts.config || await read(opts)
      const pjson = config.pjson
      const name = pjson.name
      const version = pjson.version
      const type = opts.type || 'core'

      const plugin: IPlugin = {
        name,
        version,
        root: config.root,
        tag: opts.tag,
        type,
        config,
        hooks: config.hooks,
        commands: [],
        topics: [],
        plugins: [],
      }

      if (config.pluginsModuleTS || config.hooksTS || config.commandsDirTS) {
        registerTSNode(this.debug, config.root)
      }
      if (config.pluginsModule) {
        let plugins
        let fetch = (d: string) => undefault(require(d))(config, loadPlugin)
        if (config.pluginsModuleTS) {
          try {
            plugins = await fetch(config.pluginsModuleTS)
          } catch (err) {
            cli.warn(err)
          }
        }
        if (!plugins) plugins = await fetch(config.pluginsModule)
        plugin.plugins = plugins
      }
      if (_.isArray(pjson.dxcli.plugins)) {
        const promises = pjson.dxcli.plugins.map(p => loadPlugin({root: config.root, type, name: p}).catch(cli.warn))
        plugin.plugins = _(await Promise.all(promises)).compact().flatMap().value() as IPlugin[]
      }

      this.plugins.push(plugin)
      return plugin
    }
    await loadPlugin({type: 'core', root: config.root})

    await this.runHook('legacy', {engine: this})

    // add hooks and topics
    for (let p of this._plugins) {
      for (let [hook, hooks] of Object.entries(p.hooks)) {
        this._hooks[hook] = [...this._hooks[hook] || [], ...hooks]
      }
      this._topics.push(...p.topics)
    }

    this._commands.push(..._(
      await Promise.all(this.plugins.map(p => this.loadCommands(p, loadOptions)))
    ).flatMap().value())

    // add missing topics from commands
    for (let c of this._commands) {
      let name = c.id!.split(':').slice(0, -1).join(':')
      if (!this.topics.find(t => t.name === name)) {
        this.topics.push({name})
      }
    }
  }

  findCommand(id: string, must: true): ICachedCommand
  findCommand(id: string, must?: true): ICachedCommand | undefined
  findCommand(id: string, must?: boolean): ICachedCommand | undefined {
    const cmd = this.commands.find(c => c.id === id)
    if (!cmd && must) throw new Error(`command ${id} not found`)
    return cmd
  }

  findTopic(name: string, must: true): ITopic
  findTopic(name: string, must?: boolean): ITopic | undefined
  findTopic(name: string, must?: boolean): ITopic | undefined {
    const topic = this.topics.find(t => t.name === name)
    if (!topic && must) throw new Error(`command ${name} not found`)
    return topic
  }

  async runHook<T extends {}>(event: string, opts: T) {
    this.debug('starting hook', event)
    await Promise.all((this._hooks[event] || [])
    .map(async hook => {
      try {
        this.debug('running hook', event, hook)
        const m = await undefault(require(hook))
        await m({...opts as any || {}, config: this.config})
      } catch (err) {
        if (err.code === 'EEXIT') throw err
        cli.warn(err, {context: {hook: event, module: hook}})
      }
    }))
    this.debug('finished hook', event)
  }

  protected async loadCommands(plugin: IPlugin, loadOptions: LoadOptions): Promise<ICachedCommand[]> {
    function getCached(c: ICommand): ICachedCommand {
      const opts = {plugin}
      if (c.convertToCached) return c.convertToCached(opts)
      return convertToCached(c, opts)
    }

    const getLastUpdated = async (): Promise<Date | undefined> => {
      try {
        if (loadOptions.resetCache) return new Date()
        if (!await fs.pathExists(path.join(plugin.root, '.git'))) return
        let files = await globby([`${plugin.root}/+(src|lib)/**/*.+(js|ts)`, '!**/*.+(d.ts|test.ts|test.js)'])
        let stats = await Promise.all(files.map(async f => {
          const stat = await fs.stat(f)
          return [f, stat] as [string, fs.Stats]
        }))
        const max = _.maxBy(stats, '[1].mtime')
        if (!max) return new Date()
        this.debug('most recently updated file: %s %o', max[0], max[1].mtime)
        return max[1].mtime
      } catch (err) {
        cli.warn(err)
        return new Date()
      }
    }
    const lastUpdated = await getLastUpdated()

    const debug = require('debug')(['@dxcli/load', plugin.name].join(':'))
    const cacheFile = path.join(plugin.config.cacheDir, 'commands', plugin.type, `${plugin.name}.json`)
    let cacheKey = [plugin.config.version, plugin.version]
    if (lastUpdated) cacheKey.push(lastUpdated.toISOString())
    const cache = new Cache<ICachedCommand[]>(cacheFile, cacheKey.join(':'), plugin.name)

    async function fetchFromDir(dir: string) {
      async function fetchCommandIDs(): Promise<string[]> {
        function idFromPath(file: string) {
          const p = path.parse(file)
          const topics = p.dir.split(path.sep)
          let command = p.name !== 'index' && p.name
          return _([...topics, command]).compact().join(':')
        }

        debug(`loading IDs from ${dir}`)
        const files = await globby(['**/*.+(js|ts)', '!**/*.+(d.ts|test.ts|test.js)'], {cwd: dir})
        let ids = files.map(idFromPath)
        debug('commandIDs dir: %s ids: %s', dir, ids.join(' '))
        return ids
      }

      function findCommand(id: string): ICommand {
        function commandPath(id: string): string {
          return require.resolve(path.join(dir, ...id.split(':')))
        }
        debug('fetching %s from %s', id, dir)
        const p = commandPath(id)
        let c = undefault(require(p))
        c.id = id
        return c
      }

      return (await cache.fetch('commands', async (): Promise<ICachedCommand[]> => {
        const commands = (await fetchCommandIDs())
          .map(id => {
            try {
              const cmd = findCommand(id)
              return getCached(cmd)
            } catch (err) { cli.warn(err) }
          })
        return _.compact(commands)
      }))
        .map((cmd: ICachedCommand): ICachedCommand => ({
          ...cmd,
          load: async () => findCommand(cmd.id),
        }))
    }

    let commands: ICachedCommand[] = []
    if (plugin.config.commandsDirTS) {
      try {
        commands.push(...await fetchFromDir(plugin.config.commandsDirTS))
      } catch (err) {
        cli.warn(err)
        // debug(err)
      }
    }
    if (plugin.config.commandsDir) commands.push(...await fetchFromDir(plugin.config.commandsDir))
    return commands
  }
}
