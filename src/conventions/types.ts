export interface ConventionRuleConfig {
  readonly severity?: "error" | "warning" | "info";
  readonly enabled?: boolean;
  readonly [key: string]: unknown;
}

export interface ConventionViolation {
  readonly ruleId: string;
  readonly severity: "error" | "warning" | "info";
  readonly filePath: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface ConventionCheckResult {
  readonly violations: readonly ConventionViolation[];
  readonly rulesChecked: number;
  readonly filesChecked: number;
}

export interface UiqrcConfig {
  readonly rules?: Readonly<Record<string, ConventionRuleConfig>>;
}
