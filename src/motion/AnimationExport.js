import * as THREE from 'three';
import { planSequence, sampleMove } from './MotionPlayer.js';

// Turns rig sequences into real animation clips and exports the model with them as a .glb.
//
// A clip is baked by playing the sequence on the rig frame by frame and recording each joint
// group's rotation or position, so it matches in-app playback exactly: the same speed limits
// and easing, and joints that follow others (cylinders, rods) are recorded too.

const FRAMES_PER_SECOND = 30;
// Keyframes are interpolated in straight lines, so a fast turn gets extra keys.
const MAX_DEGREES_PER_KEY = 30;
// Rig bookkeeping that must not end up in the file (rigOriginalParent is a whole object).
const RIG_USER_DATA = ['partPath', 'rigOriginalParent', 'rigJointId'];

export function restPose(rig) {
  const pose = rig.getPose();
  rig.joints.forEach((joint) => {
    if (!joint.driven) pose[joint.id] = joint.zero;
  });
  return pose;
}

// The clip starts where the sequence ends (played once from the rest pose), so it loops without
// a jump and matches what the app shows from the second time round a looping sequence.
export function sequenceTimeline(rig, sequence) {
  const firstRun = planSequence(rig, sequence, restPose(rig));
  return planSequence(rig, sequence, firstRun.endPose);
}

function sampleTimes(rig, plan) {
  if (plan.duration === 0) return [];
  if (!plan.tracks.length) return [plan.duration];
  const largestTurn = Math.max(0, ...plan.tracks
    .filter((track) => rig.jointsById.get(track.id)?.type === 'revolute')
    .map((track) => Math.abs(track.end - track.start)));
  const count = Math.max(1, Math.ceil(plan.duration * FRAMES_PER_SECOND), Math.ceil(largestTurn / MAX_DEGREES_PER_KEY));
  return Array.from({ length: count }, (_, index) => (plan.duration * (index + 1)) / count);
}

// Returns an AnimationClip, or null when the sequence moves no joint.
export function bakeSequenceClip(rig, sequence) {
  const timeline = sequenceTimeline(rig, sequence);
  if (timeline.duration <= 0) return null;

  const samples = [{ time: 0, pose: timeline.segments[0].from }];
  timeline.segments.forEach(({ start, plan, from }) => {
    sampleTimes(rig, plan).forEach((elapsed) => {
      samples.push({ time: start + elapsed, pose: { ...from, ...sampleMove(plan, elapsed) } });
    });
  });

  const records = rig.joints.map((joint) => ({ joint, values: [] }));
  const saved = rig.getPose();
  const previous = new THREE.Quaternion();
  try {
    samples.forEach(({ pose }) => {
      rig.setValues(pose);
      records.forEach(({ joint, values }) => {
        if (joint.type === 'revolute') {
          const quaternion = joint.group.quaternion.clone();
          // Keep neighbouring keys in the same hemisphere so players interpolate the short way.
          if (values.length) {
            previous.fromArray(values, values.length - 4);
            if (previous.dot(quaternion) < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
          }
          values.push(...quaternion.toArray());
        } else {
          values.push(...joint.group.position.toArray());
        }
      });
    });
  } finally {
    rig.setValues(saved);
  }

  const times = samples.map((sample) => sample.time);
  const tracks = records
    .filter(({ values }) => {
      const size = values.length / times.length;
      return values.some((value, index) => Math.abs(value - values[index % size]) > 1e-6);
    })
    .map(({ joint, values }) => (joint.type === 'revolute'
      ? new THREE.QuaternionKeyframeTrack(`${joint.group.uuid}.quaternion`, times, values)
      : new THREE.VectorKeyframeTrack(`${joint.group.uuid}.position`, times, values)));
  return tracks.length ? new THREE.AnimationClip(sequence.name, timeline.duration, tracks) : null;
}

// Objects attached to the model that are not part of its file or rig (e.g. the station's gripper).
function foreignObjects(content) {
  const found = [];
  const visit = (object) => object.children.forEach((child) => {
    if (child.userData.partPath !== undefined || child.userData.rigJointId !== undefined) visit(child);
    else found.push({ object: child, parent: object });
  });
  visit(content);
  return found;
}

// Exports the asset at its rest pose with one clip per sequence. Returns { blob, clips, skipped }.
export async function exportAnimatedGlb(asset, sequences) {
  const { rig, model, content } = asset;
  const clips = [];
  const skipped = [];
  sequences.forEach((sequence) => {
    const clip = bakeSequenceClip(rig, sequence);
    if (clip) clips.push(clip);
    else skipped.push(sequence.name);
  });
  if (!clips.length) throw new Error('None of the sequences move any joint.');

  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const pose = rig.getPose();
  const placement = { position: model.position.clone(), quaternion: model.quaternion.clone() };
  const detached = foreignObjects(content);
  const userData = [];

  try {
    rig.setValues(restPose(rig));
    // Export where the model stands, not where the base joints or station moved it.
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    detached.forEach(({ object }) => object.removeFromParent());
    model.traverse((object) => {
      if (RIG_USER_DATA.some((key) => key in object.userData)) {
        userData.push({ owner: object, original: object.userData });
        object.userData = Object.fromEntries(Object.entries(object.userData).filter(([key]) => !RIG_USER_DATA.includes(key)));
      }
      // CAD face ranges (for joint setup's surface picking) would only bloat the file.
      const geometry = object.geometry;
      if (geometry?.userData.brepFaces && !userData.some((entry) => entry.owner === geometry)) {
        userData.push({ owner: geometry, original: geometry.userData });
        geometry.userData = {};
      }
    });

    const result = await new GLTFExporter().parseAsync(model, { binary: true, animations: clips });
    return { blob: new Blob([result], { type: 'model/gltf-binary' }), clips, skipped };
  } finally {
    userData.forEach(({ owner, original }) => { owner.userData = original; });
    detached.forEach(({ object, parent }) => parent.add(object));
    rig.setValues(pose);
    model.position.copy(placement.position);
    model.quaternion.copy(placement.quaternion);
    model.updateMatrixWorld(true);
  }
}

export function downloadBlob(blob, fileName) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
