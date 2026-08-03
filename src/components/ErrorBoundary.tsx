import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

// 渲染异常兜底：出现白屏前先给出可恢复的中文提示。
// 本应用纯前端、图纸草稿保存在 localStorage，因此“重试”不会丢失用户数据。
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "未知错误"
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留完整堆栈方便排查，不让用户看到白屏。
    console.error("拼豆图纸工坊发生渲染错误：", error, info);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-card">
            <h1>出了点问题</h1>
            <p>页面渲染遇到错误，但你的图纸与本机草稿仍然安全。可以重试，或刷新页面后继续使用。</p>
            <p className="error-boundary-message">{this.state.message}</p>
            <div className="error-boundary-actions">
              <button type="button" onClick={this.handleRetry}>重试</button>
              <a href="#upload-title" onClick={this.handleRetry}>返回上传区</a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
