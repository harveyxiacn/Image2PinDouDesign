import { SHORTCUT_HELP } from "../domain/viewGestures";

/** 快捷键与手势说明，放在 Dialog 里显示。内容来自 domain/viewGestures 的 SHORTCUT_HELP。 */
export function ShortcutHelp() {
  return (
    <div className="shortcut-help" data-shortcut-help>
      {SHORTCUT_HELP.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.rows.map((row) => (
              <div key={row.keys} style={{ display: "contents" }}>
                <dt>{row.keys}</dt>
                <dd>{row.action}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="shortcut-help-foot">在输入框里打字时，单键快捷键不会触发；Ctrl / Alt 组合键只用于撤销、复制等，不会占用浏览器自己的快捷键。</p>
    </div>
  );
}
