import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useRecoilValue } from "recoil";
import * as fos from "@fiftyone/state";
import { Button } from "@fiftyone/components";
import {
  useOperatorExecutor,
  executeOperator,
  usePanelEvent,
} from "@fiftyone/operators";
import { useTheme } from "@mui/material";

interface EvaluationInfo {
  eval_key: string;
  role: "prediction" | "ground_truth";
}

interface LabelField {
  name: string;
  type: string;
  level: "sample" | "frame";
  evaluations: EvaluationInfo[];
  notes: string;
}

interface FieldMetadata {
  sample_fields: LabelField[];
  frame_fields: LabelField[];
  total_count: number;
}

interface FieldStatistics {
  name: string;
  level: "sample" | "frame";
  type: string;
  total_labels: number;
  classes: string[];
  notes: string;
}

interface StatisticsData {
  sample_fields: FieldStatistics[];
  frame_fields: FieldStatistics[];
}

interface SavedView {
  name: string;
  description: string;
  created_at?: string;
  last_modified_at?: string;
}

interface SavedViewsData {
  views: SavedView[];
  total_count: number;
}

type GroupedFields = {
  [key: string]: LabelField[];
};

export function ModelPickerPanel() {
  const theme = useTheme();
  const dataset = useRecoilValue(fos.dataset);
  const currentViewName = useRecoilValue(fos.viewName);
  const triggerPanelEvent = usePanelEvent();

  const metadataExecutor = useOperatorExecutor<FieldMetadata>(
    "@prernadh/model_picker/get_label_fields_metadata"
  );

  const statisticsExecutor = useOperatorExecutor<StatisticsData>(
    "@prernadh/model_picker/get_label_fields_statistics"
  );

  const savedViewsExecutor = useOperatorExecutor<SavedViewsData>(
    "@prernadh/model_picker/list_model_picker_views"
  );

  const [activeTab, setActiveTab] = useState<"select" | "statistics" | "saved-views">("select");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<"level" | "type" | "evaluations">("type");
  const [isApplying, setIsApplying] = useState(false);
  const [justCreatedView, setJustCreatedView] = useState<string | null>(null);
  const [deletedViews, setDeletedViews] = useState<Set<string>>(new Set());

  // Clear "just created" highlight and deleted views when dataset changes
  useEffect(() => {
    setJustCreatedView(null);
    setDeletedViews(new Set());
  }, [dataset?.name]);

  // Clear highlight when navigating away from Saved Views tab
  useEffect(() => {
    if (activeTab !== "saved-views" && justCreatedView) {
      setJustCreatedView(null);
    }
  }, [activeTab, justCreatedView]);

  // Create theme-aware styles
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    if (dataset) {
      metadataExecutor.execute();
      // Only load statistics when switching to statistics tab
      if (activeTab === "statistics") {
        statisticsExecutor.execute();
      }
      // Only load saved views when switching to saved views tab
      if (activeTab === "saved-views") {
        savedViewsExecutor.execute();
      }
    }
  }, [dataset?.name, activeTab]);

  useEffect(() => {
    if (metadataExecutor.result) {
      const allFields = [
        ...metadataExecutor.result.sample_fields,
        ...metadataExecutor.result.frame_fields,
      ];
      setSelectedFields(new Set(allFields.map(f => f.name)));
    }
  }, [metadataExecutor.result]);

  const filteredFields = useMemo(() => {
    if (!metadataExecutor.result) return { sample_fields: [], frame_fields: [] };

    const search = searchTerm.toLowerCase();
    return {
      sample_fields: metadataExecutor.result.sample_fields.filter(f =>
        f.name.toLowerCase().includes(search) ||
        f.type.toLowerCase().includes(search)
      ),
      frame_fields: metadataExecutor.result.frame_fields.filter(f =>
        f.name.toLowerCase().includes(search) ||
        f.type.toLowerCase().includes(search)
      ),
    };
  }, [metadataExecutor.result, searchTerm]);

  const groupedByType = useMemo(() => {
    const allFields = [
      ...filteredFields.sample_fields,
      ...filteredFields.frame_fields,
    ];

    return allFields.reduce((acc, field) => {
      if (!acc[field.type]) {
        acc[field.type] = [];
      }
      acc[field.type].push(field);
      return acc;
    }, {} as GroupedFields);
  }, [filteredFields]);

  const groupedByEvaluations = useMemo(() => {
    const allFields = [
      ...filteredFields.sample_fields,
      ...filteredFields.frame_fields,
    ];

    const evalToFields: { [key: string]: Array<LabelField & { evalRole?: string }> } = {};
    const noEvalFields: LabelField[] = [];

    allFields.forEach(field => {
      if (field.evaluations && field.evaluations.length > 0) {
        // Add field to each evaluation it's associated with
        field.evaluations.forEach((evalInfo: EvaluationInfo) => {
          const evalKey = evalInfo.eval_key;
          if (!evalToFields[evalKey]) {
            evalToFields[evalKey] = [];
          }
          // Add field with role information
          evalToFields[evalKey].push({
            ...field,
            evalRole: evalInfo.role
          });
        });
      } else {
        noEvalFields.push(field);
      }
    });

    // Sort fields within each evaluation: ground_truth first, then prediction
    Object.keys(evalToFields).forEach(evalKey => {
      evalToFields[evalKey].sort((a, b) => {
        if (a.evalRole === "ground_truth" && b.evalRole === "prediction") return -1;
        if (a.evalRole === "prediction" && b.evalRole === "ground_truth") return 1;
        return 0;
      });
    });

    // Add "No Evaluations" group if there are fields without evaluations
    if (noEvalFields.length > 0) {
      evalToFields["No Evaluations"] = noEvalFields;
    }

    return evalToFields;
  }, [filteredFields]);

  const handleToggleField = useCallback((fieldName: string) => {
    setSelectedFields(prev => {
      const next = new Set(prev);
      if (next.has(fieldName)) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allFields = [
      ...filteredFields.sample_fields,
      ...filteredFields.frame_fields,
    ];
    setSelectedFields(new Set(allFields.map(f => f.name)));
  }, [filteredFields]);

  const handleDeselectAll = useCallback(() => {
    setSelectedFields(new Set());
  }, []);

  const handleNotesChange = useCallback(async (fieldName: string, notes: string) => {
    try {
      await executeOperator(
        "@prernadh/model_picker/update_field_notes",
        { field_name: fieldName, notes: notes }
      );
      // Note: We don't refresh metadata here to avoid resetting the UI
      // The notes will be loaded fresh on next panel mount or tab switch
    } catch (error) {
      // Silently fail - notes update is non-critical
    }
  }, []);

  const handleApply = useCallback(async () => {
    setIsApplying(true);
    try {
      await executeOperator(
        "@prernadh/model_picker/apply_model_picker",
        { selected_fields: Array.from(selectedFields) }
      );
    } catch (error) {
      // Silently fail - view update is non-critical
    } finally {
      setIsApplying(false);
    }
  }, [selectedFields]);

  // Show loading while metadata is being fetched
  if (metadataExecutor.isLoading || !metadataExecutor.result) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h2 style={styles.title}>Model Picker</h2>
          <p style={styles.subtitle}>
            Select which model predictions to display in the sidebar
          </p>
        </div>
        <div style={styles.tabContainer}>
          <button
            style={activeTab === "select" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("select")}
          >
            Select Fields
          </button>
          <button
            style={activeTab === "statistics" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("statistics")}
          >
            Field Statistics
          </button>
          <button
            style={activeTab === "saved-views" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("saved-views")}
          >
            Saved Views
          </button>
        </div>
        <div style={styles.loading}>Loading label fields...</div>
      </div>
    );
  }

  if (metadataExecutor.error) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h2 style={styles.title}>Model Picker</h2>
          <p style={styles.subtitle}>
            Select which model predictions to display in the sidebar
          </p>
        </div>
        <div style={styles.tabContainer}>
          <button
            style={activeTab === "select" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("select")}
          >
            Select Fields
          </button>
          <button
            style={activeTab === "statistics" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("statistics")}
          >
            Field Statistics
          </button>
          <button
            style={activeTab === "saved-views" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("saved-views")}
          >
            Saved Views
          </button>
        </div>
        <div style={styles.error}>
          Error loading label fields: {String(metadataExecutor.error)}
        </div>
      </div>
    );
  }

  if (metadataExecutor.result.total_count === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h2 style={styles.title}>Model Picker</h2>
          <p style={styles.subtitle}>
            Select which model predictions to display in the sidebar
          </p>
        </div>
        <div style={styles.tabContainer}>
          <button
            style={activeTab === "select" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("select")}
          >
            Select Fields
          </button>
          <button
            style={activeTab === "statistics" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("statistics")}
          >
            Field Statistics
          </button>
          <button
            style={activeTab === "saved-views" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("saved-views")}
          >
            Saved Views
          </button>
        </div>
        <div style={styles.empty}>
          No label fields found in this dataset.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Model Picker</h2>
        <p style={styles.subtitle}>
          {activeTab === "select"
            ? "Select which model predictions to display in the sidebar"
            : activeTab === "statistics"
            ? "View statistics about label fields"
            : "Manage saved field selection presets"}
        </p>
      </div>

      <div style={styles.tabContainer}>
        <button
          style={activeTab === "select" ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab("select")}
        >
          Select Fields
        </button>
        <button
          style={activeTab === "statistics" ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab("statistics")}
        >
          Field Statistics
        </button>
        <button
          style={activeTab === "saved-views" ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab("saved-views")}
        >
          Saved Views
        </button>
      </div>

      {activeTab === "select" ? (
        <SelectFieldsTab
          dataset={dataset}
          filteredFields={filteredFields}
          groupedByType={groupedByType}
          groupedByEvaluations={groupedByEvaluations}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          selectedFields={selectedFields}
          handleToggleField={handleToggleField}
          handleSelectAll={handleSelectAll}
          handleDeselectAll={handleDeselectAll}
          handleNotesChange={handleNotesChange}
          handleApply={handleApply}
          isApplying={isApplying}
          setIsApplying={setIsApplying}
          totalCount={metadataExecutor.result?.total_count || 0}
          savedViewsExecutor={savedViewsExecutor}
          triggerPanelEvent={triggerPanelEvent}
          setActiveTab={setActiveTab}
          setJustCreatedView={setJustCreatedView}
          styles={styles}
        />
      ) : activeTab === "statistics" ? (
        <StatisticsTab
          dataset={dataset}
          statisticsExecutor={statisticsExecutor}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
          handleNotesChange={handleNotesChange}
          filteredFields={filteredFields}
          styles={styles}
        />
      ) : (
        <SavedViewsTab
          savedViewsExecutor={savedViewsExecutor}
          currentViewName={currentViewName}
          triggerPanelEvent={triggerPanelEvent}
          justCreatedView={justCreatedView}
          setJustCreatedView={setJustCreatedView}
          deletedViews={deletedViews}
          setDeletedViews={setDeletedViews}
          styles={styles}
        />
      )}
    </div>
  );
}

function SelectFieldsTab({
  dataset,
  filteredFields,
  groupedByType,
  groupedByEvaluations,
  groupBy,
  setGroupBy,
  searchTerm,
  setSearchTerm,
  selectedFields,
  handleToggleField,
  handleSelectAll,
  handleDeselectAll,
  handleNotesChange,
  handleApply,
  isApplying,
  setIsApplying,
  totalCount,
  savedViewsExecutor,
  triggerPanelEvent,
  setActiveTab,
  setJustCreatedView,
  styles,
}: any) {
  const isVideoDataset = dataset?.mediaType === "video";

  return (
    <>
      <div style={styles.controls}>
        <input
          type="text"
          placeholder="Search fields..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={styles.searchInput}
        />

        <div style={styles.groupByToggle}>
          <label>Group by:</label>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as "level" | "type" | "evaluations")}
            style={styles.select}
          >
            {isVideoDataset && <option value="level">Level (Sample/Frame)</option>}
            <option value="type">Label Type</option>
            <option value="evaluations">Model Evaluations</option>
          </select>
        </div>
      </div>

      <div style={styles.fieldList}>
        {groupBy === "level" ? (
          <>
            {filteredFields.sample_fields.length > 0 && (
              <FieldGroup
                title="Sample-Level Fields"
                fields={filteredFields.sample_fields}
                selectedFields={selectedFields}
                onToggle={handleToggleField}
                onNotesChange={handleNotesChange}
                hideEvaluations={false}
                showEvalRole={false}
                styles={styles}
              />
            )}
            {filteredFields.frame_fields.length > 0 && (
              <FieldGroup
                title="Frame-Level Fields"
                fields={filteredFields.frame_fields}
                selectedFields={selectedFields}
                onToggle={handleToggleField}
                onNotesChange={handleNotesChange}
                hideEvaluations={false}
                showEvalRole={false}
                styles={styles}
              />
            )}
          </>
        ) : groupBy === "type" ? (
          Object.entries(groupedByType).map(([type, fields]) => (
            <FieldGroup
              key={type}
              title={type}
              fields={fields as Array<LabelField & { evalRole?: string }>}
              selectedFields={selectedFields}
              onToggle={handleToggleField}
              onNotesChange={handleNotesChange}
              hideEvaluations={false}
              showEvalRole={false}
              styles={styles}
            />
          ))
        ) : (
          Object.entries(groupedByEvaluations).map(([evalName, fields]) => (
            <FieldGroup
              key={evalName}
              title={evalName === "No Evaluations" ? evalName : `Evaluation key: ${evalName}`}
              fields={fields as Array<LabelField & { evalRole?: string }>}
              selectedFields={selectedFields}
              onToggle={handleToggleField}
              onNotesChange={handleNotesChange}
              hideEvaluations={true}
              showEvalRole={true}
              styles={styles}
            />
          ))
        )}
      </div>

      <div style={styles.buttonGroup}>
        <Button onClick={handleSelectAll} variant="text" size="small">
          Select All
        </Button>
        <Button onClick={handleDeselectAll} variant="text" size="small">
          Deselect All
        </Button>
      </div>

      <div style={styles.footer}>
        <div style={styles.selectionCount}>
          {selectedFields.size} of {totalCount} fields selected
        </div>
        <div style={styles.footerButtons}>
          <Button
            onClick={handleApply}
            disabled={isApplying || selectedFields.size === 0}
            variant="contained"
            color="primary"
          >
            {isApplying ? "Applying..." : "Apply Selection"}
          </Button>
          <Button
            onClick={() => {
              // Use our custom operator that automatically adds [Model Picker] prefix
              triggerPanelEvent("model-picker-panel", {
                operator: "@prernadh/model_picker/save_model_picker_view",
                params: {},
                prompt: true,
                callback: async (result: any) => {
                  // Extract view name
                  const viewName = result?.view_name || result?.result?.view_name;

                  // Refresh saved views list
                  await savedViewsExecutor.execute();

                  if (viewName) {
                    // Mark this view as just created
                    setJustCreatedView(viewName);

                    // Navigate to Saved Views tab
                    setActiveTab("saved-views");
                  }
                }
              });
            }}
            variant="outlined"
            size="small"
            title="Save the current view with [Model Picker] prefix"
          >
            Save Current View
          </Button>
        </div>
      </div>
    </>
  );
}

interface StatisticsCardProps {
  stat: FieldStatistics;
  onNotesChange: (fieldName: string, notes: string) => void;
  evalRole?: "prediction" | "ground_truth";
  styles: any;
}

function StatisticsCard({ stat, onNotesChange, evalRole, styles }: StatisticsCardProps) {
  // Use stat.notes as the initial value and keep saved notes in state
  const [savedNotes, setSavedNotes] = useState<string>(stat.notes);
  const [editingNotes, setEditingNotes] = useState<string | undefined>(undefined);

  // Update savedNotes when stat.notes changes (e.g., on tab switch)
  useEffect(() => {
    setSavedNotes(stat.notes);
  }, [stat.notes]);

  const handleNotesChange = (value: string) => {
    setEditingNotes(value);
  };

  const handleNotesBlur = async () => {
    if (editingNotes !== undefined) {
      await onNotesChange(stat.name, editingNotes);
      // Save the edited notes locally and clear editing state
      setSavedNotes(editingNotes);
      setEditingNotes(undefined);
    }
  };

  const displayValue = editingNotes !== undefined ? editingNotes : savedNotes;

  return (
    <div style={styles.statCard}>
      <div style={styles.statHeader}>
        <span style={styles.statFieldName}>{stat.name}</span>
        <span style={styles.statFieldType}>{stat.type}</span>
        {evalRole && (
          <span style={evalRole === "prediction" ? styles.predictionBadge : styles.groundTruthBadge}>
            {evalRole === "prediction" ? "Prediction Field" : "Ground Truth Field"}
          </span>
        )}
      </div>
      <div style={styles.statBody}>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Total Labels:</span>
          <span style={styles.statValue}>{stat.total_labels.toLocaleString()}</span>
        </div>
        {stat.classes.length > 0 && (
          <div style={styles.statRow}>
            <span style={styles.statLabel}>Classes ({stat.classes.length}):</span>
            <div style={styles.classesContainer}>
              {stat.classes.map((cls, idx) => (
                <span key={idx} style={styles.classBadge}>
                  {cls}
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={styles.notesContainer}>
          <label style={styles.notesLabel}>Notes:</label>
          <textarea
            value={displayValue}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => handleNotesChange(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="Add notes about this field..."
            style={styles.notesInput}
            rows={2}
          />
        </div>
      </div>
    </div>
  );
}

function StatisticsTab({ dataset, statisticsExecutor, groupBy, setGroupBy, handleNotesChange, filteredFields, styles }: any) {
  const isVideoDataset = dataset?.mediaType === "video";
  // Show loading while executing
  if (statisticsExecutor.isLoading || !statisticsExecutor.result) {
    return <div style={styles.loading}>Computing statistics...</div>;
  }

  if (statisticsExecutor.error) {
    return (
      <div style={styles.error}>
        Error loading statistics: {String(statisticsExecutor.error)}
      </div>
    );
  }

  // Check if there are actually no fields after loading completed
  const hasFields =
    statisticsExecutor.result.sample_fields.length > 0 ||
    statisticsExecutor.result.frame_fields.length > 0;

  if (!hasFields) {
    return <div style={styles.empty}>No label fields found in this dataset.</div>;
  }

  const allStats = [
    ...statisticsExecutor.result.sample_fields,
    ...statisticsExecutor.result.frame_fields,
  ];

  // Group by type if needed
  const groupedByType = allStats.reduce((acc: { [key: string]: FieldStatistics[] }, stat: FieldStatistics) => {
    if (!acc[stat.type]) {
      acc[stat.type] = [];
    }
    acc[stat.type].push(stat);
    return acc;
  }, {} as { [key: string]: FieldStatistics[] });

  // Group by evaluations
  const groupedByEvaluations = (() => {
    // Get metadata for evaluations info
    const allFields = [
      ...filteredFields.sample_fields,
      ...filteredFields.frame_fields,
    ];

    const evalToStats: { [key: string]: Array<FieldStatistics & { evalRole?: string }> } = {};
    const noEvalStats: FieldStatistics[] = [];

    allStats.forEach(stat => {
      // Find the corresponding field to get evaluations
      const field = allFields.find(f => f.name === stat.name);

      if (field && field.evaluations && field.evaluations.length > 0) {
        field.evaluations.forEach((evalInfo: EvaluationInfo) => {
          const evalKey = evalInfo.eval_key;
          if (!evalToStats[evalKey]) {
            evalToStats[evalKey] = [];
          }
          evalToStats[evalKey].push({
            ...stat,
            evalRole: evalInfo.role
          });
        });
      } else {
        noEvalStats.push(stat);
      }
    });

    // Sort fields within each evaluation: ground_truth first, then prediction
    Object.keys(evalToStats).forEach(evalKey => {
      evalToStats[evalKey].sort((a, b) => {
        if (a.evalRole === "ground_truth" && b.evalRole === "prediction") return -1;
        if (a.evalRole === "prediction" && b.evalRole === "ground_truth") return 1;
        return 0;
      });
    });

    // Add "No Evaluations" group if there are stats without evaluations
    if (noEvalStats.length > 0) {
      evalToStats["No Evaluations"] = noEvalStats;
    }

    return evalToStats;
  })();

  const renderStatCard = (stat: FieldStatistics) => (
    <StatisticsCard
      key={stat.name}
      stat={stat}
      onNotesChange={handleNotesChange}
      styles={styles}
    />
  );

  const renderStatCardWithRole = (stat: FieldStatistics & { evalRole?: string }) => (
    <StatisticsCard
      key={stat.name}
      stat={stat}
      onNotesChange={handleNotesChange}
      evalRole={stat.evalRole as "prediction" | "ground_truth" | undefined}
      styles={styles}
    />
  );

  const sampleStats = statisticsExecutor.result.sample_fields;
  const frameStats = statisticsExecutor.result.frame_fields;

  return (
    <>
      <div style={styles.controls}>
        <div style={styles.groupByToggle}>
          <label>Group by:</label>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as "level" | "type" | "evaluations")}
            style={styles.select}
          >
            {isVideoDataset && <option value="level">Level (Sample/Frame)</option>}
            <option value="type">Label Type</option>
            <option value="evaluations">Model Evaluations</option>
          </select>
        </div>
      </div>

      <div style={styles.statisticsContainer}>
        {groupBy === "level" ? (
          <>
            {sampleStats.length > 0 && (
              <StatisticsGroup
                title="Sample-Level Fields"
                stats={sampleStats}
                renderStatCard={renderStatCard}
                styles={styles}
              />
            )}
            {frameStats.length > 0 && (
              <StatisticsGroup
                title="Frame-Level Fields"
                stats={frameStats}
                renderStatCard={renderStatCard}
                styles={styles}
              />
            )}
          </>
        ) : groupBy === "type" ? (
          Object.entries(groupedByType).map(([type, stats]) => (
            <StatisticsGroup
              key={type}
              title={type}
              stats={stats as FieldStatistics[]}
              renderStatCard={renderStatCard}
              styles={styles}
            />
          ))
        ) : (
          Object.entries(groupedByEvaluations).map(([evalName, stats]) => (
            <StatisticsGroup
              key={evalName}
              title={evalName === "No Evaluations" ? evalName : `Evaluation key: ${evalName}`}
              stats={stats as Array<FieldStatistics & { evalRole?: string }>}
              renderStatCard={renderStatCardWithRole}
              styles={styles}
            />
          ))
        )}
      </div>
    </>
  );
}

interface FieldGroupProps {
  title: string;
  fields: Array<LabelField & { evalRole?: string }>;
  selectedFields: Set<string>;
  onToggle: (fieldName: string) => void;
  onNotesChange: (fieldName: string, notes: string) => void;
  hideEvaluations: boolean;
  showEvalRole: boolean;
  styles: any;
}

function FieldGroup({ title, fields, selectedFields, onToggle, onNotesChange, hideEvaluations, showEvalRole, styles }: FieldGroupProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [savedNotes, setSavedNotes] = useState<{[key: string]: string}>({});
  const [editingNotes, setEditingNotes] = useState<{[key: string]: string}>({});

  // Initialize savedNotes from fields whenever they change
  useEffect(() => {
    const initialNotes: {[key: string]: string} = {};
    fields.forEach(field => {
      initialNotes[field.name] = field.notes;
    });
    setSavedNotes(initialNotes);
  }, [fields]);

  const handleNotesChange = (fieldName: string, value: string) => {
    setEditingNotes((prev: {[key: string]: string}) => ({ ...prev, [fieldName]: value }));
  };

  const handleNotesBlur = async (fieldName: string) => {
    const notes = editingNotes[fieldName];
    if (notes !== undefined) {
      await onNotesChange(fieldName, notes);
      // Save to local state and clear editing state
      setSavedNotes((prev: {[key: string]: string}) => ({ ...prev, [fieldName]: notes }));
      setEditingNotes((prev: {[key: string]: string}) => {
        const newState = { ...prev };
        delete newState[fieldName];
        return newState;
      });
    }
  };

  const getDisplayValue = (fieldName: string, fieldNotes: string) => {
    if (editingNotes[fieldName] !== undefined) {
      return editingNotes[fieldName];
    }
    if (savedNotes[fieldName] !== undefined) {
      return savedNotes[fieldName];
    }
    return fieldNotes;
  };

  return (
    <div style={styles.fieldGroup}>
      <div
        style={styles.groupHeader}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span style={styles.groupTitle}>{title}</span>
        <span style={styles.groupCount}>({fields.length})</span>
        <span style={styles.expandIcon}>{isExpanded ? "▼" : "▶"}</span>
      </div>

      {isExpanded && (
        <div style={styles.groupContent}>
          {fields.map(field => (
            <div key={field.name} style={styles.fieldItem}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={selectedFields.has(field.name)}
                  onChange={() => onToggle(field.name)}
                  style={styles.checkbox}
                />
                <span style={styles.fieldName}>{field.name}</span>
                <span style={styles.fieldType}>{field.type}</span>
                {showEvalRole && field.evalRole && (
                  <span style={field.evalRole === "prediction" ? styles.predictionBadge : styles.groundTruthBadge}>
                    {field.evalRole === "prediction" ? "Prediction Field" : "Ground Truth Field"}
                  </span>
                )}
              </label>
              {!hideEvaluations && field.evaluations && field.evaluations.length > 0 && (
                <div style={styles.evaluationInfo}>
                  <span style={styles.evaluationLabel}>Evaluations:</span>
                  {field.evaluations.map((evalInfo, idx) => (
                    <span key={idx} style={styles.evaluationBadge}>
                      {typeof evalInfo === 'string' ? evalInfo : evalInfo.eval_key}
                    </span>
                  ))}
                </div>
              )}
              <div style={styles.notesContainer}>
                <label style={styles.notesLabel}>Notes:</label>
                <textarea
                  value={getDisplayValue(field.name, field.notes)}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => handleNotesChange(field.name, e.target.value)}
                  onBlur={() => handleNotesBlur(field.name)}
                  placeholder="Add notes about this field..."
                  style={styles.notesInput}
                  rows={2}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface StatisticsGroupProps {
  title: string;
  stats: FieldStatistics[];
  renderStatCard: (stat: FieldStatistics) => React.ReactElement;
  styles: any;
}

function StatisticsGroup({ title, stats, renderStatCard, styles }: StatisticsGroupProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div style={styles.fieldGroup}>
      <div
        style={styles.groupHeader}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span style={styles.groupTitle}>{title}</span>
        <span style={styles.groupCount}>({stats.length})</span>
        <span style={styles.expandIcon}>{isExpanded ? "▼" : "▶"}</span>
      </div>

      {isExpanded && (
        <div style={styles.groupContent}>
          {stats.map(renderStatCard)}
        </div>
      )}
    </div>
  );
}

function SavedViewsTab({ savedViewsExecutor, currentViewName, triggerPanelEvent, justCreatedView, setJustCreatedView, deletedViews, setDeletedViews, styles }: any) {

  // Show loading while executing
  if (savedViewsExecutor.isLoading || !savedViewsExecutor.result) {
    return <div style={styles.loading}>Loading saved views...</div>;
  }

  if (savedViewsExecutor.error) {
    return (
      <div style={styles.error}>
        Error loading saved views: {String(savedViewsExecutor.error)}
      </div>
    );
  }

  const handleLoadView = async (viewName: string) => {
    try {
      // Clear the "just created" highlight when loading a view
      setJustCreatedView(null);

      // Use the built-in FiftyOne load operator
      await executeOperator("load_saved_view", {
        name: viewName,
      });
    } catch (error: any) {
      // Silently fail - view loading errors are handled by FiftyOne UI
    }
  };

  const handleDeleteView = async (viewName: string) => {
    // Add to deleted views set FIRST to immediately hide it from UI (optimistic update)
    setDeletedViews((prev: Set<string>) => {
      const newSet = new Set([...prev, viewName]);
      return newSet;
    });

    // Use triggerPanelEvent with custom operator to ensure proper execution
    triggerPanelEvent("model-picker-panel", {
      operator: "@prernadh/model_picker/delete_model_picker_view",
      params: { name: viewName },
      prompt: false,
      callback: async () => {
        // Force reload the saved views list to get fresh data from backend
        await savedViewsExecutor.execute();

        // Clear the deletedViews set after reload completes
        setDeletedViews(new Set());
      }
    });
  };

  // Filter out deleted views from the display (for optimistic UI updates)
  const views = (savedViewsExecutor.result.views || []).filter(
    (view: SavedView) => !deletedViews.has(view.name)
  );

  // Reverse the order from list_saved_views (most recent first)
  const sortedViews = [...views].reverse();

  if (sortedViews.length === 0) {
    return (
      <div style={styles.empty}>
        No saved views found. Use the "Save Current View" button in the Select Fields tab to create one.
      </div>
    );
  }

  return (
    <div style={styles.savedViewsContainer}>
      {sortedViews.map((view: SavedView) => {
        const isActive = currentViewName === view.name;
        const isJustCreated = justCreatedView === view.name;

        let cardStyle = styles.savedViewCard;
        if (isActive) {
          cardStyle = { ...cardStyle, ...styles.savedViewCardActive };
        }
        if (isJustCreated) {
          cardStyle = { ...cardStyle, ...styles.savedViewCardJustCreated };
        }

        return (
          <div key={view.name} style={cardStyle}>
            <div style={styles.savedViewHeader}>
              <span style={styles.savedViewName}>
                {view.name}
                {isActive && <span style={styles.activeIndicator}> ● Active</span>}
                {isJustCreated && <span style={styles.justCreatedIndicator}> ● Just Created</span>}
              </span>
            </div>
            {view.description && (
              <div style={styles.savedViewDescription}>{view.description}</div>
            )}
            <div style={styles.savedViewActions}>
              <Button
                onClick={() => handleLoadView(view.name)}
                variant="contained"
                size="small"
                color="primary"
                disabled={isActive}
              >
                {isActive ? "Loaded" : "Load View"}
              </Button>
              <Button
                onClick={() => handleDeleteView(view.name)}
                variant="text"
                size="small"
              >
                Delete
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function createStyles(theme: any) {
  const isDark = theme.palette.mode === "dark";

  return {
    container: {
      display: "flex",
      flexDirection: "column" as const,
      height: "100%",
      padding: "16px",
      backgroundColor: theme.palette.background.default,
      color: theme.palette.text.primary,
      fontFamily: "system-ui, -apple-system, sans-serif",
    },
    header: {
      marginBottom: "16px",
    },
    title: {
      fontSize: "20px",
      fontWeight: 600,
      margin: "0 0 8px 0",
      color: theme.palette.text.primary,
    },
    subtitle: {
      fontSize: "14px",
      color: theme.palette.text.secondary,
      margin: 0,
    },
    tabContainer: {
      display: "flex",
      gap: "8px",
      marginBottom: "16px",
      borderBottom: `2px solid ${theme.palette.divider}`,
    },
    tab: {
      padding: "8px 16px",
      fontSize: "14px",
      fontWeight: 500,
      background: "none",
      border: "none",
      borderBottom: "2px solid transparent",
      marginBottom: "-2px",
      cursor: "pointer",
      color: theme.palette.text.secondary,
      transition: "all 0.2s",
    },
    tabActive: {
      padding: "8px 16px",
      fontSize: "14px",
      fontWeight: 600,
      background: "none",
      border: "none",
      borderBottom: `2px solid ${theme.palette.primary.main}`,
      marginBottom: "-2px",
      cursor: "pointer",
      color: theme.palette.primary.main,
      transition: "all 0.2s",
    },
    controls: {
      display: "flex",
      flexDirection: "column" as const,
      gap: "12px",
      marginBottom: "16px",
      paddingBottom: "16px",
      borderBottom: `1px solid ${theme.palette.divider}`,
    },
    searchInput: {
      padding: "8px 12px",
      fontSize: "14px",
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: "4px",
      width: "100%",
      backgroundColor: theme.palette.background.paper,
      color: theme.palette.text.primary,
    },
    buttonGroup: {
      display: "flex",
      gap: "8px",
      marginBottom: "16px",
    },
    groupByToggle: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontSize: "14px",
      color: theme.palette.text.primary,
    },
    select: {
      padding: "4px 8px",
      fontSize: "14px",
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: "4px",
      backgroundColor: theme.palette.background.paper,
      color: theme.palette.text.primary,
    },
    fieldList: {
      overflowY: "auto" as const,
      marginBottom: "16px",
      maxHeight: "calc(100vh - 400px)",
    },
    fieldGroup: {
      marginBottom: "16px",
    },
    groupHeader: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "8px 12px",
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.05)"
        : "rgba(0, 0, 0, 0.04)",
      borderRadius: "4px",
      cursor: "pointer",
      userSelect: "none" as const,
      color: theme.palette.text.primary,
    },
    groupTitle: {
      fontWeight: 600,
      fontSize: "14px",
      flex: 1,
      color: theme.palette.text.primary,
    },
    groupCount: {
      fontSize: "12px",
      color: theme.palette.text.secondary,
    },
    expandIcon: {
      fontSize: "10px",
      color: theme.palette.text.secondary,
    },
    groupContent: {
      padding: "8px 0",
    },
    fieldItem: {
      marginBottom: "4px",
    },
    checkboxLabel: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 12px",
      cursor: "pointer",
      borderRadius: "4px",
      color: theme.palette.text.primary,
    },
    checkbox: {
      cursor: "pointer",
    },
    fieldName: {
      flex: 1,
      fontSize: "14px",
      fontFamily: "monospace",
      color: theme.palette.text.primary,
    },
    fieldType: {
      fontSize: "12px",
      color: theme.palette.text.secondary,
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.08)"
        : "rgba(0, 0, 0, 0.06)",
      padding: "2px 8px",
      borderRadius: "3px",
    },
    evaluationInfo: {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      paddingLeft: "40px",
      paddingBottom: "4px",
      flexWrap: "wrap" as const,
    },
    evaluationLabel: {
      fontSize: "11px",
      color: theme.palette.text.secondary,
      fontWeight: 500,
    },
    evaluationBadge: {
      fontSize: "11px",
      color: isDark ? "#90caf9" : "#1976d2",
      backgroundColor: isDark
        ? "rgba(144, 202, 249, 0.12)"
        : "rgba(25, 118, 210, 0.08)",
      padding: "2px 6px",
      borderRadius: "3px",
      fontFamily: "monospace",
    },
    predictionBadge: {
      fontSize: "11px",
      color: isDark ? "#ff9800" : "#e65100",
      backgroundColor: isDark
        ? "rgba(255, 152, 0, 0.12)"
        : "rgba(255, 152, 0, 0.08)",
      padding: "2px 8px",
      borderRadius: "3px",
      fontWeight: 600,
      marginLeft: "8px",
    },
    groundTruthBadge: {
      fontSize: "11px",
      color: isDark ? "#4caf50" : "#2e7d32",
      backgroundColor: isDark
        ? "rgba(76, 175, 80, 0.12)"
        : "rgba(76, 175, 80, 0.08)",
      padding: "2px 8px",
      borderRadius: "3px",
      fontWeight: 600,
      marginLeft: "8px",
    },
    notesContainer: {
      marginTop: "8px",
      paddingLeft: "24px",
    },
    notesLabel: {
      fontSize: "12px",
      color: theme.palette.text.secondary,
      marginBottom: "4px",
      display: "block",
    },
    notesInput: {
      width: "100%",
      padding: "6px 8px",
      fontSize: "12px",
      fontFamily: "inherit",
      color: theme.palette.text.primary,
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.05)"
        : "rgba(0, 0, 0, 0.02)",
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: "4px",
      resize: "vertical" as const,
      outline: "none",
      transition: "border-color 0.2s",
      "&:focus": {
        borderColor: theme.palette.primary.main,
      },
    },
    footer: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: "16px",
      borderTop: `1px solid ${theme.palette.divider}`,
    },
    footerButtons: {
      display: "flex",
      gap: "8px",
      alignItems: "center",
    },
    selectionCount: {
      fontSize: "14px",
      color: theme.palette.text.secondary,
    },
    loading: {
      padding: "24px",
      textAlign: "center" as const,
      color: theme.palette.text.secondary,
    },
    error: {
      padding: "24px",
      color: theme.palette.error.main,
      backgroundColor: isDark
        ? "rgba(211, 47, 47, 0.15)"
        : "#ffebee",
      borderRadius: "4px",
    },
    empty: {
      padding: "24px",
      textAlign: "center" as const,
      color: theme.palette.text.secondary,
    },
    statisticsContainer: {
      overflowY: "auto" as const,
      maxHeight: "calc(100vh - 400px)",
      padding: "8px 0",
    },
    statGroupSection: {
      marginBottom: "24px",
    },
    statGroupTitle: {
      fontSize: "16px",
      fontWeight: 600,
      color: theme.palette.text.primary,
      marginBottom: "12px",
      paddingBottom: "8px",
      borderBottom: `2px solid ${theme.palette.divider}`,
    },
    statCard: {
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.03)"
        : "rgba(0, 0, 0, 0.02)",
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: "6px",
      padding: "12px",
      marginBottom: "12px",
    },
    statHeader: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "12px",
      paddingBottom: "8px",
      borderBottom: `1px solid ${theme.palette.divider}`,
    },
    statFieldName: {
      fontSize: "15px",
      fontWeight: 600,
      fontFamily: "monospace",
      color: theme.palette.text.primary,
    },
    statFieldType: {
      fontSize: "12px",
      color: theme.palette.text.secondary,
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.08)"
        : "rgba(0, 0, 0, 0.06)",
      padding: "2px 8px",
      borderRadius: "3px",
    },
    statBody: {
      display: "flex",
      flexDirection: "column" as const,
      gap: "8px",
    },
    statRow: {
      display: "flex",
      flexDirection: "column" as const,
      gap: "4px",
    },
    statLabel: {
      fontSize: "12px",
      fontWeight: 600,
      color: theme.palette.text.secondary,
      textTransform: "uppercase" as const,
    },
    statValue: {
      fontSize: "18px",
      fontWeight: 600,
      color: theme.palette.text.primary,
    },
    classesContainer: {
      display: "flex",
      flexWrap: "wrap" as const,
      gap: "6px",
      marginTop: "4px",
    },
    classBadge: {
      fontSize: "12px",
      color: theme.palette.text.primary,
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.1)"
        : "rgba(0, 0, 0, 0.08)",
      padding: "4px 8px",
      borderRadius: "4px",
      fontFamily: "monospace",
    },
    savedViewsContainer: {
      overflowY: "auto" as const,
      maxHeight: "calc(100vh - 400px)",
      padding: "8px 0",
    },
    savedViewCard: {
      backgroundColor: isDark
        ? "rgba(255, 255, 255, 0.03)"
        : "rgba(0, 0, 0, 0.02)",
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: "6px",
      padding: "16px",
      marginBottom: "12px",
    },
    savedViewCardActive: {
      border: `2px solid #4caf50`,
      boxShadow: `0 0 8px rgba(76, 175, 80, 0.3)`,
    },
    savedViewCardJustCreated: {
      border: `2px solid #ff9800`,
      boxShadow: `0 0 8px rgba(255, 152, 0, 0.3)`,
    },
    savedViewHeader: {
      marginBottom: "8px",
    },
    savedViewName: {
      fontSize: "16px",
      fontWeight: 600,
      fontFamily: "monospace",
      color: theme.palette.text.primary,
    },
    activeIndicator: {
      color: "#4caf50",
      fontSize: "14px",
      fontWeight: 500,
    },
    justCreatedIndicator: {
      color: "#ff9800",
      fontSize: "14px",
      fontWeight: 500,
    },
    savedViewDescription: {
      fontSize: "14px",
      color: theme.palette.text.secondary,
      marginBottom: "12px",
      lineHeight: "1.5",
    },
    savedViewActions: {
      display: "flex",
      gap: "8px",
      marginTop: "12px",
    },
  };
}
