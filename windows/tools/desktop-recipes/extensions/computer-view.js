
// Appended to the original 1.3.0 Computer settings module; $e, Y, W and Ie are its
// section, row, button and type styles. The Host page manages the Bot's computer.
function GrokRemoteDesktop() {
  return (0, Q.jsx)($e, { anchorId: 'bot-computer', title: grokText('远程桌面', 'Remote desktop'), children: (0, Q.jsx)(Y, {
    anchorId: null, label: grokText('Bot 的运行环境', 'Where your Bot runs'), variant: 'card',
    children: (0, Q.jsx)(W, { onClick: () => window.localBot.openManagement(), size: 'md', style: Ie.sm, type: 'button', variant: 'secondary', children: grokText('管理', 'Manage') }),
  }) });
}
