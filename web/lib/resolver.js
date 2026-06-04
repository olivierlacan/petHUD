// Port of lib/pethud/patient_resolver.rb — maps a report's identity to a
// canonical patient via the rules in patients.json (e.g. merges "IRIS REED"
// and "IRIS PARK" into one Iris). Unmatched reports get an auto-created patient
// keyed by external id (or name+owner) so nothing is silently merged.
//
// One instance per aggregation run (it caches auto-created patients).

export class PatientResolver {
  // config: the parsed patients.json ({ patients: [...] })
  constructor(config) {
    this.rules = (config?.patients ?? []).map((p) => {
      const match = p.match ?? {};
      return {
        slug: p.slug,
        name: p.name,
        species: p.species,
        notes: p.notes,
        names: (match.names ?? []).map((s) => String(s).toUpperCase().trim()),
        owners: (match.owners ?? []).map((s) => String(s).toUpperCase().trim()),
        external_ids: (match.external_ids ?? []).map((s) => String(s).trim()),
      };
    });
    this.auto = new Map();
  }

  resolve(meta) {
    const name = String(meta.pet_name ?? "").toUpperCase().trim();
    const owner = String(meta.pet_owner ?? "").toUpperCase().trim();
    const ext = String(meta.patient_external_id ?? "").trim();

    const rule = this.rules.find((r) =>
      (ext !== "" && r.external_ids.includes(ext)) ||
      (name !== "" && r.names.includes(name)) ||
      (owner !== "" && r.owners.includes(owner)));

    if (rule) {
      return { slug: rule.slug, name: rule.name, species: rule.species ?? meta.species, notes: rule.notes };
    }
    return this.autoPatient(meta, name, owner, ext);
  }

  autoPatient(meta, name, owner, ext) {
    const key = ext === "" ? `${name}-${owner}` : ext;
    if (this.auto.has(key)) return this.auto.get(key);

    let slug = slugify(meta.pet_name || meta.pet_owner || key);
    if ([...this.auto.values()].some((p) => p.slug === slug)) slug = `${slug}-${key}`;
    const patient = {
      slug,
      name: titleCase(meta.pet_name || meta.pet_owner || "Unknown"),
      species: meta.species,
      notes: "Auto-created (no alias rule matched).",
    };
    this.auto.set(key, patient);
    return patient;
  }
}

function slugify(str) {
  return String(str ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleCase(str) {
  return String(str ?? "").split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
