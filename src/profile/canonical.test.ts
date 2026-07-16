import { describe, it, expect } from 'vitest';
import { mapDeterministic } from './canonical.js';

describe('deterministic intake mapping (real Sales Intake fields)', () => {
  const intake: Record<string, string> = {
    'Timestamp': '2026-06-18',
    'Name Of Office': 'Smile Dental',
    'Website URL': 'https://www.smiledental.com',
    'First Name': 'Jane',
    'Name of Office Manager': 'Pat Lee',
    'Email Address of Doctor': 'jane@smiledental.com',
    'Office Manager Email Address': 'pat@smiledental.com',
    'Street Address': '123 Main St',
    'Office Phone Number': '555-1000',
    'Mobile phone number for doctor': '555-2000',
    'MMW Package': 'Platinum',
    'Special Additions or things promised': 'free logo',
    'Length Of Contract': '12 months',
    'Start Date': '2026-07-01',
    'City': 'Dallas',
    'State': 'TX',
    'Zip Code': '75001',
    'Book to Mail': 'yes',
    'Last Name': 'Doe',
    'Client Specialty': 'Dental',
    'Invoice Amount': '$2000',
    'Website Build notes': 'redesign',
    'Website Build Type': 'WordPress',
  };

  it('maps every field with no fallthrough and no sensitive leakage', () => {
    const { profile, sensitive, toAI } = mapDeterministic(intake, 'intake');
    expect(toAI).toEqual([]);
    expect(Object.keys(sensitive)).toEqual([]);
    expect(profile.office_name).toBe('Smile Dental');
    expect(profile.website_url).toBe('https://www.smiledental.com');
    expect(profile.doctor_email).toBe('jane@smiledental.com');
    expect(profile.office_manager_email).toBe('pat@smiledental.com');
    expect(profile.nap_phone).toBe('555-1000');
    expect(profile.doctor_mobile).toBe('555-2000');
    expect(profile.nap_street).toBe('123 Main St');
    expect(profile.website_build_notes).toBe('redesign');
    expect(profile.website_build_type).toBe('WordPress');
    expect(profile.package).toBe('Platinum');
  });
});

describe('deterministic clientform mapping — sensitive routing', () => {
  const clientform: Record<string, string> = {
    'What is your NPI#? (we need this for claiming & verification)': '1234567890',
    'What is your DEA Number (we need this for verification)': 'BX1234567',
    'What is your State License Number (we need this for verification)': 'SL-99',
    'What state(s) are you licensed to practice in?': 'TX, OK',
    'What is your domain LOGIN and PASSWORD?  This is where you purchased your domain': 'godaddy/secret',
    'What is your website LOGIN? We need the URL to the login page, the username and the password to your Wordpress': 'wp-admin/secret',
    'Where are your website DNS settings managed? (provide logins if different than your domain registrar)': 'cloudflare/secret',
    'What are your top services that you want to grow?': 'implants',
    'Please Describe Your Ideal Patient?': 'adults 40+',
    'What is the EXACT OFFICE ADDRESS that you want listed on Google?': '123 Main St',
    'What is the OFFICE EMAIL ADDRESS that you want listed on Google?': 'office@smiledental.com',
  };

  it('routes credentials to the sensitive bucket, not the open profile', () => {
    const { profile, sensitive } = mapDeterministic(clientform, 'clientform');
    // sensitive values never appear in the open profile
    expect(sensitive.npi).toBe('1234567890');
    expect(sensitive.dea).toBe('BX1234567');
    expect(sensitive.state_license).toBe('SL-99');
    expect(sensitive.domain_credentials).toBe('godaddy/secret');
    expect(sensitive.website_credentials).toBe('wp-admin/secret');
    expect(sensitive.dns_credentials).toBe('cloudflare/secret');
    for (const k of Object.keys(sensitive)) expect(profile[k]).toBeUndefined();
    // "licensed to practice in" is the non-sensitive list, distinct from the license NUMBER
    expect(profile.licensed_states).toBe('TX, OK');
    expect(profile.focus_services).toBe('implants');
    expect(profile.nap_address).toBe('123 Main St');
    expect(profile.nap_email).toBe('office@smiledental.com');
  });
});

describe('deterministic clientform mapping — non-answer scrubbing (real form junk values)', () => {
  it('drops n/a-style placeholders instead of storing them, and reports them for review', () => {
    const clientform: Record<string, string> = {
      'Where did you do your residency?': 'N/A',
      'What is Your Lifetime Patient Value $$?': '??',
      'What are your board-certifications and awards?': 'na',
    };
    const { profile, dropped } = mapDeterministic(clientform, 'clientform');
    expect(profile.residency).toBeUndefined();
    expect(profile.lifetime_patient_value).toBeUndefined();
    expect(profile.credentials).toBeUndefined();
    expect(dropped.map((d) => d.reason)).toEqual([
      'non_answer:residency',
      'non_answer:lifetime_patient_value',
      'non_answer:credentials',
    ]);
  });

  it('never scrubs legitimate "No" / "None" answers to yes/no questions', () => {
    const clientform: Record<string, string> = {
      'Do you have other locations?  If so please list those below with their correct addresses.': 'No',
      'Are you a member of your Chamber of Commerce?  Which one(s)?': 'None',
    };
    const { profile, dropped } = mapDeterministic(clientform, 'clientform');
    expect(profile.other_locations).toBe('No');
    expect(profile.chamber_of_commerce).toBe('None');
    expect(dropped).toEqual([]);
  });
});

describe('deterministic clientform mapping — duplicate/legacy question variants', () => {
  it('keeps the first non-empty answer when two labels map to the same canonical key', () => {
    // The form has accumulated multiple office-hours phrasings over the years.
    const clientform: Record<string, string> = {
      'What are your office hours that you want listed online?': 'Wed-Sat 10-5',
      'What are your correct office hours?': 'Mon-Fri 9-5', // legacy duplicate, should NOT win
    };
    const { profile, dropped } = mapDeterministic(clientform, 'clientform');
    expect(profile.office_hours).toBe('Wed-Sat 10-5');
    expect(dropped).toEqual([{ raw_label: 'What are your correct office hours?', raw_value: 'Mon-Fri 9-5', reason: 'duplicate_of:office_hours' }]);
  });

  it('does not flag a duplicate when the second occurrence is empty', () => {
    const clientform: Record<string, string> = {
      'What are your office hours that you want listed online?': 'Wed-Sat 10-5',
      'What are the office hours that you want listed online?': '',
    };
    const { profile, dropped } = mapDeterministic(clientform, 'clientform');
    expect(profile.office_hours).toBe('Wed-Sat 10-5');
    expect(dropped).toEqual([]);
  });
});
