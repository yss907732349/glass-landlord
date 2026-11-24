import type { SkillDefinition, SkillKind } from './types.ts';

export const SKILLS: SkillDefinition[] = [
  { kind: 'steal', name: '顺手牵羊', description: '偷走目标随机一张牌，目标至少留一张。', weight: 16, target: true, select: 0, tone: 'normal' },
  { kind: 'gift', name: '礼尚往来', description: '把自己选的一张手牌送给目标，自己至少留一张。', weight: 14, target: true, select: 1, tone: 'normal' },
  { kind: 'peek', name: '让我康康', description: '偷偷看目标随机三张牌，不足三张则全部查看。', weight: 12, target: true, select: 0, tone: 'normal' },
  { kind: 'wild', name: '万能救场', description: '获得一张赖子：单出算3，组合可代3～A，不参与炸弹。已有赖子时不能再生成。', weight: 6, target: false, select: 0, tone: 'rare' },
  { kind: 'three', name: '送你一个3', description: '额外生成一张3，塞进目标手牌。', weight: 10, target: true, select: 0, tone: 'normal' },
  { kind: 'trade', name: '强买强卖', description: '用自己选的两张牌，换走目标随机一张牌。', weight: 14, target: true, select: 2, tone: 'rare' },
  { kind: 'shuffle', name: '全桌洗手', description: '混合所有人的手牌，按原张数重新发放。每局最多两次。', weight: 2, target: false, select: 0, tone: 'epic' },
  { kind: 'mutual', name: '你也别跑', description: '你和目标各获得三张3～7的小牌。一起坐牢！', weight: 3, target: true, select: 0, tone: 'rare' },
  { kind: 'identity', name: '身份互换', description: '与相反身份的目标交换阵营，手牌不变。每局限一次。', weight: 1, target: true, select: 0, tone: 'epic' },
  { kind: 'addTwo', name: '加倍关照', description: '额外生成两张3～2的随机牌，交给目标。', weight: 6, target: true, select: 0, tone: 'rare' },
  { kind: 'reverse', name: '反向操作', description: '立即反转出牌方向，仍由你完成当前回合。两次反转相互抵消。', weight: 16, target: false, select: 0, tone: 'normal' },
];

export function getSkill(kind: SkillKind): SkillDefinition {
  const skill = SKILLS.find(item => item.kind === kind);
  if (!skill) throw new Error('未知技能牌。');
  return skill;
}
