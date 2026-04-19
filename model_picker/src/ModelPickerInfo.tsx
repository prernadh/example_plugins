import React from "react";

/**
 * Simple informational panel for the Model Picker plugin.
 *
 * This panel displays instructions and status information.
 * Users interact with the plugin via the "Model Picker" button
 * in the samples grid actions, which triggers the Python operator.
 */
export function ModelPickerInfo() {
  const styles = {
    container: {
      padding: "24px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      maxWidth: "600px",
      margin: "0 auto",
    },
    header: {
      fontSize: "24px",
      fontWeight: "600",
      marginBottom: "16px",
      color: "#1a1a1a",
    },
    description: {
      fontSize: "14px",
      lineHeight: "1.6",
      color: "#666",
      marginBottom: "24px",
    },
    section: {
      marginBottom: "24px",
      padding: "16px",
      backgroundColor: "#f5f5f5",
      borderRadius: "8px",
      border: "1px solid #e0e0e0",
    },
    sectionTitle: {
      fontSize: "16px",
      fontWeight: "600",
      marginBottom: "12px",
      color: "#1a1a1a",
    },
    list: {
      margin: "0",
      paddingLeft: "20px",
    },
    listItem: {
      marginBottom: "8px",
      fontSize: "14px",
      lineHeight: "1.5",
    },
    button: {
      display: "inline-block",
      padding: "8px 16px",
      backgroundColor: "#1976d2",
      color: "white",
      borderRadius: "4px",
      fontWeight: "500",
      fontSize: "14px",
      border: "none",
      cursor: "not-allowed",
      opacity: "0.7",
    },
    code: {
      fontFamily: "monospace",
      backgroundColor: "#e8e8e8",
      padding: "2px 6px",
      borderRadius: "3px",
      fontSize: "13px",
    },
    emoji: {
      fontSize: "20px",
      marginRight: "8px",
    },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>
        <span style={styles.emoji}>🎯</span>
        Model Picker
      </h1>

      <p style={styles.description}>
        A powerful plugin to manage which model predictions are displayed in your FiftyOne app.
        Select the models you want to work with and hide the rest!
      </p>

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>
          <span style={styles.emoji}>📖</span>
          How to Use
        </h2>
        <ol style={styles.list}>
          <li style={styles.listItem}>
            Look for the <span style={styles.code}>Model Picker</span> button in the samples grid actions toolbar
          </li>
          <li style={styles.listItem}>
            Click the button to open the model selection dialog
          </li>
          <li style={styles.listItem}>
            Check/uncheck the models you want to display
          </li>
          <li style={styles.listItem}>
            Click <span style={styles.code}>Execute</span> to apply your selection
          </li>
          <li style={styles.listItem}>
            The sidebar will update to show only the selected model fields
          </li>
        </ol>
      </div>

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>
          <span style={styles.emoji}>✨</span>
          Features
        </h2>
        <ul style={styles.list}>
          <li style={styles.listItem}>
            <strong>Selective Display:</strong> Show only the models you're actively working with
          </li>
          <li style={styles.listItem}>
            <strong>Clean Sidebar:</strong> Reduce clutter by hiding unused prediction fields
          </li>
          <li style={styles.listItem}>
            <strong>Evaluation Support:</strong> Automatically handles associated evaluation results
          </li>
          <li style={styles.listItem}>
            <strong>Frame Fields:</strong> Works with both sample-level and frame-level predictions
          </li>
        </ul>
      </div>

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>
          <span style={styles.emoji}>💡</span>
          Pro Tips
        </h2>
        <ul style={styles.list}>
          <li style={styles.listItem}>
            Unselected models aren't deleted—just hidden from view
          </li>
          <li style={styles.listItem}>
            Run the operator again anytime to change your selection
          </li>
          <li style={styles.listItem}>
            Works great for datasets with many different model predictions
          </li>
          <li style={styles.listItem}>
            Helps you focus on comparing specific models side-by-side
          </li>
        </ul>
      </div>

      <div style={{
        ...styles.section,
        backgroundColor: "#e3f2fd",
        borderColor: "#90caf9",
      }}>
        <h2 style={styles.sectionTitle}>
          <span style={styles.emoji}>🚀</span>
          Getting Started
        </h2>
        <p style={{ fontSize: "14px", lineHeight: "1.6", margin: 0 }}>
          This panel is informational only. To use the Model Picker, click the{" "}
          <strong>Model Picker</strong> button in the samples grid toolbar above.
          The operator will show you all available model fields and let you select
          which ones to display.
        </p>
      </div>

      <div style={{ marginTop: "24px", textAlign: "center", fontSize: "12px", color: "#999" }}>
        <p>Model Picker Plugin v1.0.0</p>
        <p>Built with ❤️ for FiftyOne</p>
      </div>
    </div>
  );
}
