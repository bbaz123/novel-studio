import { editingRuleCatalog, EDITING_RULE_VERSION, buildEditingRuleBlock, resolveEditingSelection } from '../ai/editing/rules.mjs';
const c = editingRuleCatalog();
console.log('version:', EDITING_RULE_VERSION);
console.log('abilities:', c.abilities.map((a) => `${a.id}(${a.chars}字,hash=${a.hash})`).join('\n            '));
const sel = resolveEditingSelection({ edit_rules_enabled: '1', edit_tier: 'deai', edit_abilities: 'fiction-humanizer,narrative-distance,scene-logic', edit_genre: 'urban' });
const blk = buildEditingRuleBlock(sel, { task: 'write' });
console.log('\nsources:', blk.sources.map((s) => s.id).join('、'));
console.log('block chars:', blk.text.length, 'hash:', blk.hash);
console.log('含叙述距离:', blk.text.includes('叙述距离'), '含场景逻辑:', blk.text.includes('场景逻辑'));
