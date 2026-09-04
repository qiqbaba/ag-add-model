/* eslint-disable */
/**
 * 坑 25（终极范式修正）：LS 对自定义模型走【prompt-based 工具调用】——
 * 请求体没有 tools 字段，工具定义全部在 systemInstruction 文本里（实测 dump
 * 证实），并明确指示模型："Formulate your tool calls using the xml and json
 * format specified for each tool. The tool name should be the xml tag
 * surrounding the tool call. The tool arguments should be in a valid json
 * inside of it"，且"ALL tool calls at the END of your message"。
 *
 * 也就是说：LS 靠解析模型响应【文本】中的 <tool_name>{json}</tool_name> 来
 * 获取调用——根本不看 functionCall part（这对占位模型一律忽略，坑24 的
 * supportsToolCalls 与帧结构修复全都无效的原因）。
 *
 * 此前的翻译层把上游文本标记消费掉、重建成 functionCall part，恰好把 LS
 * 要解析的东西消灭了。正确做法：解析是为了【验证与规范化】，交付时序列化
 * 回 LS 期待的标准 XML+JSON 文本，作为普通 text part 输出。
 */
import { normalizeToolArgs } from './utils.js';
import { sanitizeToolMetadata } from './openai.js';

/**
 * 将解析出的工具调用序列化为 LS system prompt 定义的标准形态：
 *   <tool_name>
 *   {"Arg":"value",...}
 *   </tool_name>
 * 多个调用依次拼接（prompt 规定调用必须分组置于消息末尾）。
 */
export function serializeToolCallsAsPromptXml(fcs: { name: string; args: Record<string, unknown> }[]): string {
  const blocks: string[] = [];
  for (const fc of fcs) {
    const na = normalizeToolArgs(fc.name, fc.args) as Record<string, unknown>;
    // toolSummary/toolAction/WaitMsBeforeAsync 是 LS 校验的必填参数，缺失或
    // 乱码时合成合法值（与 functionCall 通道同一套规则）。
    sanitizeToolMetadata(fc.name, na);
    blocks.push(`<${fc.name}>\n${JSON.stringify(na)}\n</${fc.name}>`);
  }
  return blocks.join('\n');
}
