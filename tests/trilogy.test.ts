// Cross-game regression tests on the shipped content: long prerequisite chains must stay reachable.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Engine } from '../src/storylet/engine.ts';
import type { Option, State } from '../src/storylet/engine.ts';
import { parse } from '../src/storylet/expr.ts';
import { loadContent } from '../src/storylet/loader.ts';
import { PyRandom } from '../src/storylet/pyrandom.ts';
import type { Value } from '../src/storylet/pycompat.ts';
import { ROOT } from './helpers.ts';

// A deliberate "golden" ME2 -> ME3 career: everyone recruited and loyal, ideal suicide-mission
// picks, heretics rewritten, Koris saved; every optional op done before the point of no return.
const GOLDEN: ReadonlyMap<string, string> = new Map(
  Object.entries({
    'campaign.start'           : 'me2',
    'me2.genesis.rachni'       : 'released',
    'me2.player.style'         : 'paragon',
    'me2.recruit.legion'       : 'activate',
    'me2.loyalty.legion'       : 'rewrite',
    'me2.loyalty.mordin'       : 'keep_data',
    'me2.loyalty.tali'         : 'charm',
    'me2.conflict.miranda_jack': 'resolve',
    'me2.conflict.tali_legion' : 'resolve',
    'me2.sm.choose_tech'       : 'legion',
    'me2.sm.choose_leader1'    : 'garrus',
    'me2.sm.choose_biotic'     : 'samara',
    'me2.sm.choose_leader2'    : 'miranda',
    'me2.sm.choose_escort'     : 'mordin',
    'me2.sm.choose_party1'     : 'kasumi',
    'me2.sm.choose_party2'     : 'tali',
    'me2.sm.final_decision'    : 'destroy',
    'me3.citadel.standoff'     : 'talk_down',
    'me3.rannoch.admiral_koris': 'save_koris',
    'me3.rannoch.reaper_base'  : 'peace',
    'me3.genophage.shroud'     : 'cure',
    'me3.thessia'              : 'challenge_tim',
    'me3.horizon'              : 'miranda_warned',
    'me3.monastery'            : 'stop_samara',
    'me3.attican.krogan_team'  : 'free_queen',
    'me3.earth.illusive_man'   : 'persuade',
    'me3.earth.catalyst'       : 'destroy',
  }),
);
const LAST = new Set(['me2.sm.launch', 'me3.import.me2_save', 'me3.cronos', 'me3.earth.london']);

/**
 * Scripted picks are taken as soon as they are offered in ME2, where windows close (Legion must
 * be reactivated before the crew is taken). In ME3 the career is a completionist: optional
 * content comes first, because priority missions close it and its reputation is what the
 * persuasion checks need. The point-of-no-return storylets in LAST always come last.
 */
function goldenPolicy(state: State, opts: readonly Option[]): Option {
  const scripted = opts.filter(([st, cid]) => GOLDEN.get(st.id) === cid);
  const free = opts.filter(([st]) => !LAST.has(st.id) && !GOLDEN.has(st.id));
  const inMe3 = new Map(state.values).get('story.game') === 3;
  for (const pool of inMe3 ? [free, scripted] : [scripted, free]) if (pool.length) return pool[0]!;
  return opts[0]!;
}

describe('trilogy', () => {
  const content = loadContent(path.join(ROOT, 'content'));
  const engine = new Engine(content);
  const val = (state: State, src: string): Value => engine.eval(parse(src), state);

  it('plays the golden career', () => {
    const s = engine.run(engine.initial(), new PyRandom(0), undefined, goldenPolicy).final;
    // every scripted pick was taken; otherwise the policy silently fell back to another option
    assert.deepEqual([...GOLDEN].filter((pair) => !s.chosen.has(pair)).sort(), []);
    assert.equal(val(s, 'me2.progress.game_done && !story.me2.shepard_dead'), true);
    assert.equal(
      val(s, 'count(me2.squad.legion.dead, me2.squad.tali.dead, me2.squad.garrus.dead)'),
      0,
    );
    assert.ok(s.chosen.has(['me3.rannoch.reaper_base', 'peace'])); // needs ~8 decisions across ME2+ME3
    assert.equal(val(s, 'me3.end.tim_suicide'), true); // lifted IM_Final_Persuade
    assert.ok((val(s, 'me3.ems.current_rating') as number) >= 4000);
    assert.equal(val(s, 'me3.end.shepard_alive && me3.end.earth_ok'), true);
  });

  it("reads ME1's Virmire outcome directly from ME3", () => {
    // LE3's Kaiden_Is_Dead reads ME1's Rescued_Kaidan (me1.bool.3828) through the +10000 alias.
    assert.equal(
      val(engine.initial({ 'me1.virmire.rescued_ash': true }), 'me3.fate.kaidan_dead'),
      true,
    );
    assert.equal(
      val(engine.initial({ 'me1.virmire.rescued_kaidan': true }), 'me3.fate.kaidan_dead'),
      false,
    );
  });

  it("tracks Wrex's fate across three games", () => {
    const alive = engine.initial({ 'me1.squad.wrex': true });
    assert.equal(val(alive, 'me3.fate.wrex_dead'), false);
    const shot = engine.initial({
      'me1.squad.wrex'                   : true,
      'me1.virmire.wrex_killed_by_player': true,
    });
    assert.equal(val(shot, 'me3.fate.wrex_dead'), true);
    // ME3: a sabotaged cure + Wrex alive after Rannoch -> the Citadel confrontation fires
    const later = engine.initial({
      'me1.squad.wrex'              : true,
      'me3.genophage.cure_sabotaged': true,
      'me3.order.Gth002'            : 12,
    });
    assert.equal(val(later, 'me3.citadel.time_for_wrex_confrontation'), true);
  });

  it('puts Wreav in charge unless Wrex ended ME1 in the squad', () => {
    // LE3 decides by the lifted Wrex_is_present, not by Wrex_is_dead.
    const careers: [string, Record<string, Value>, boolean][] = [
      ['talked down', { 'me1.squad.wrex': true, 'me1.virmire.wrex_success': true }, false],
      [
        'shot on Virmire',
        { 'me1.virmire.wrex_failure': true, 'me1.virmire.wrex_killed_by_player': true },
        true,
      ],
      ['never recruited', {}, true], // also a fresh ME3 start: every table at its default
    ];
    for (const [name, overrides, wreav] of careers) {
      assert.equal(val(engine.initial(overrides), 'me3.genophage.wreav_leads'), wreav, name);
    }
    assert.equal(val(engine.initial(), 'me3.fate.wrex_dead'), false); // why Wrex_is_dead is the wrong test
  });

  it('puts Wreav in charge after Wrex died in the Genesis comic', () => {
    for (const [virmire, wreav] of [
      ['kaidan_lives_wrex_dies', true],
      ['kaidan_lives_wrex_lives', false],
    ] as const) {
      let s = engine.fire(engine.initial(), 'campaign.start', 'me2');
      for (const [sid, cid] of [
        ['me2.genesis.shepard', 'male'],
        ['me2.genesis.fist', 'killed'],
        ['me2.genesis.rachni', 'killed'],
        ['me2.genesis.virmire', virmire],
      ] as const) {
        s = engine.fire(s, sid, cid);
      }
      assert.equal(val(s, 'me3.genophage.wreav_leads'), wreav, virmire);
    }
  });

  it('lets Mordin be talked out of the cure', () => {
    // Needs Wreav in charge and Eve dead, i.e. Maelon's data destroyed (regression: the choice
    // used to test eve_dead, which only the same storylet's effects set, so it never appeared).
    const shroud = content.storylets.get('me3.genophage.shroud')!;
    const base = {
      'story.game'                : 3,
      'me3.order.KroGar'          : 1,
      'me3.order.Kro001'          : 2,
      'me2.squad.mordin.recruited': true,
    };
    const offered = (extra: Record<string, Value>): boolean =>
      engine
        .choices(shroud, engine.initial({ ...base, ...extra }))
        .some((c) => c.id === 'sabotage_persuade');
    assert.equal(offered({}), true);
    assert.equal(offered({ 'me2.mordin.saved_data': true }), false);
    assert.equal(offered({ 'me1.squad.wrex': true }), false);
    const s = engine.fire(engine.initial(base), shroud, 'sabotage_persuade');
    assert.equal(val(s, 'me3.genophage.eve_dead && me3.genophage.sabotage_mordin_lived'), true);
  });

  /** Fire the final battle, holding the line and the escape from a constructed state.
   * `squad` maps each recruited squadmate to whether they are loyal. */
  const holdTheLine = (
    squad: Record<string, boolean>,
    party: readonly [string, string] = ['grunt', 'zaeed'],
  ): [Set<string>, State] => {
    const ov: Record<string, Value> = {
      'story.game'         : 2,
      'story.me2.sm.escort': 'none',
      'story.me2.sm.party1': party[0],
      'story.me2.sm.party2': party[1],
    };
    for (const [who, loyal] of Object.entries(squad)) {
      ov[`me2.squad.${who}.recruited`] = true;
      ov[`me2.squad.${who}.loyal`] = loyal;
    }
    let s = engine.initial(ov);
    for (const sid of ['me2.sm.final_battle', 'me2.sm.hold_the_line', 'me2.sm.shepard_fate']) {
      s = engine.fire(s, sid);
    }
    const fallen = new Set(
      [...s.chosen].filter(([sid]) => sid === 'me2.sm.hold_the_line').map(([, c]) => c),
    );
    return [fallen, s];
  };

  it('takes disloyal defenders first in a weak defence, then anyone', () => {
    // Defenders mordin (0, disloyal), tali/kasumi/jack (0 + 1 loyal): average 0.75 -> two die.
    // Only one is disloyal, so the limited pass crosses into the full priority list.
    const [fallen, s] = holdTheLine({
      mordin: false,
      tali  : true,
      kasumi: true,
      jack  : true,
      grunt : true,
      zaeed : true,
    });
    assert.deepEqual(fallen, new Set(['mordin_falls_disloyal', 'tali_falls']));
    assert.equal(val(s, 'story.me2.shepard_dead'), false);
  });

  it('loses nobody in a strong defence', () => {
    const [fallen, s] = holdTheLine(
      { garrus: true, grunt: true, zaeed: true, miranda: true, jacob: true },
      ['miranda', 'jacob'],
    );
    assert.deepEqual(fallen, new Set());
    assert.ok(s.fired.has('me2.sm.hold_the_line'));
    assert.ok(s.fired.has('me2.sm.shepard_fate'));
    assert.equal(
      val(s, 'count(me2.squad.garrus.dead, me2.squad.grunt.dead, me2.squad.zaeed.dead)'),
      0,
    );
  });

  it('lifts the Tuchanka bomb timer', () => {
    assert.equal(
      val(
        engine.initial({ 'me3.order.KroN7a': 5, 'me3.progress.mission_count': 7 }),
        'me3.tuchanka.bomb_exploded',
      ),
      false,
    );
    assert.equal(
      val(
        engine.initial({ 'me3.order.KroN7a': 5, 'me3.progress.mission_count': 8 }),
        'me3.tuchanka.bomb_exploded',
      ),
      true,
    );
  });
});
