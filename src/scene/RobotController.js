import * as THREE from 'three';
import { ROBOT_LIMITS } from './RobotLimits.js';
import { ROBOT_POSES } from './RobotPoses.js';
import { ROBOT_TASKS } from './RobotTasks.js';

const JOINT_NAMES = ['Link1', 'Link2', 'Link3', 'Link4', 'Link5', 'Link6'];
const JOINT_AXES = {
  Link1: 'z',
  Link2: 'y',
  Link3: 'y',
  Link4: 'x',
  Link5: 'y',
  Link6: 'x',
};
const MAX_SPEEDS = {
  Link1: 35,
  Link2: 60,
  Link3: 90,
  Link4: 120,
  Link5: 160,
  Link6: 220,
};
const MOTION_MIN_DURATION = 0.35;
const MOTION_MAX_DURATION = 8;

function trapezoidProgress(progress) {
  const acceleration = 0.2;
  const cruise = 0.6;
  const peakVelocity = 1 / (acceleration + cruise);

  if (progress <= acceleration) return 0.5 * (peakVelocity / acceleration) * progress ** 2;
  if (progress <= acceleration + cruise) return 0.125 + peakVelocity * (progress - acceleration);

  const decelerationProgress = progress - acceleration - cruise;
  return 0.875 + peakVelocity * decelerationProgress
    - 0.5 * (peakVelocity / acceleration) * decelerationProgress ** 2;
}

export class RobotController {
  constructor(robot) {
    this.robot = robot;
    this.base = robot.getObjectByName('Base');
    this.links = new Map();
    this.initialRotations = new Map();
    this.activeMotion = null;

    JOINT_NAMES.forEach((linkName) => {
      const link = robot.getObjectByName(linkName);
      this.links.set(linkName, link);
      if (link) {
        this.initialRotations.set(linkName, link.rotation.clone());
        console.info(`\u2713 ${linkName} found`);
      } else {
        console.warn(`Missing robot joint: ${linkName}`);
      }
    });

    if (!this.base) console.warn('Missing robot base: Base');
  }

  get isMoving() {
    return this.activeMotion !== null;
  }

  getJointAngle(linkName) {
    const link = this.links.get(linkName);
    const initialRotation = this.initialRotations.get(linkName);
    if (!link || !initialRotation) return null;

    const axis = JOINT_AXES[linkName];
    return THREE.MathUtils.radToDeg(link.rotation[axis] - initialRotation[axis]);
  }

  getJointAngles() {
    return JOINT_NAMES.map((linkName) => ({ linkName, angle: this.getJointAngle(linkName) }));
  }

  getCurrentPose() {
    const pose = {};
    JOINT_NAMES.forEach((linkName) => {
      pose[linkName] = this.getJointAngle(linkName);
    });
    return pose;
  }

  moveJoint(linkName, angle) {
    return this.moveJointToOffset(linkName, angle);
  }

  moveJointToOffset(linkName, angle) {
    const target = this.getCurrentPose();
    target[linkName] = angle;
    return this.moveJ(target);
  }

  moveJointRelative(linkName, deltaAngle) {
    const currentAngle = this.getJointAngle(linkName);
    if (currentAngle === null) return Promise.reject(new Error(`Cannot jog missing joint: ${linkName}`));
    return this.moveJointToOffset(linkName, currentAngle + deltaAngle);
  }

  moveJ(targetPose) {
    if (this.activeMotion) return Promise.reject(new Error('A joint is already moving.'));

    const tracks = [];
    for (const linkName of JOINT_NAMES) {
      const currentAngle = this.getJointAngle(linkName);
      const targetAngle = Number.isFinite(targetPose[linkName]) ? targetPose[linkName] : currentAngle;
      const limits = ROBOT_LIMITS[linkName];

      if (!Number.isFinite(targetAngle)) return Promise.reject(new Error(`Invalid target for ${linkName}`));
      if (limits && (targetAngle < limits.min || targetAngle > limits.max)) {
        console.warn(`${linkName} motion blocked: ${targetAngle.toFixed(1)}° exceeds limits ${limits.min}° to ${limits.max}°.`);
        return Promise.reject(new Error(`Joint limit exceeded: ${linkName}`));
      }

      if (this.links.get(linkName) && Math.abs(targetAngle - currentAngle) > 0.001) {
        tracks.push({
          linkName,
          link: this.links.get(linkName),
          axis: JOINT_AXES[linkName],
          startAngle: currentAngle,
          targetAngle,
          duration: Math.max(MOTION_MIN_DURATION, Math.abs(targetAngle - currentAngle) / MAX_SPEEDS[linkName]),
        });
      }
    }

    if (tracks.length === 0) return Promise.resolve();

    const duration = Math.min(MOTION_MAX_DURATION, Math.max(...tracks.map((track) => track.duration)));
    return new Promise((resolve) => {
      this.activeMotion = { type: 'MoveJ', tracks, duration, elapsed: 0, resolve };
    });
  }

  movePose(pose) {
    const target = {};
    JOINT_NAMES.forEach((linkName) => {
      target[linkName] = Number.isFinite(pose[linkName]) ? pose[linkName] : 0;
    });
    return this.moveJ(target);
  }

  home() {
    return this.movePose(ROBOT_POSES.home);
  }

  sync() {
    return this.movePose(ROBOT_POSES.sync);
  }

  ready() {
    return this.movePose(ROBOT_POSES.ready);
  }

  async calibration() {
    await this.sync();
    for (const linkName of ROBOT_TASKS.calibration) {
      const current = this.getJointAngle(linkName);
      const limits = ROBOT_LIMITS[linkName];
      await this.moveJointToOffset(linkName, Math.min(current + 5, limits.max));
      await this.moveJointToOffset(linkName, Math.max(current - 5, limits.min));
      await this.moveJointToOffset(linkName, 0);
    }
    await this.sync();
  }

  async reachForward() {
    await this.movePose(ROBOT_POSES.reachForward);
    await this.pause(0.75);
    await this.home();
  }

  async inspectionScan() {
    await this.ready();
    await this.moveJ(ROBOT_TASKS.inspectionSweep.start);
    await this.pause(0.75);
    await this.moveJ(ROBOT_TASKS.inspectionSweep.end);
    await this.pause(0.75);
    await this.home();
  }

  update(deltaTime) {
    if (!this.activeMotion) return;

    const motion = this.activeMotion;
    motion.elapsed = Math.min(motion.elapsed + deltaTime, motion.duration);
    motion.tracks.forEach((track) => {
      const localProgress = Math.min(motion.elapsed / track.duration, 1);
      const progress = trapezoidProgress(localProgress);
      const angle = THREE.MathUtils.lerp(track.startAngle, track.targetAngle, progress);
      const initialRotation = this.initialRotations.get(track.linkName);
      track.link.rotation[track.axis] = initialRotation[track.axis] + THREE.MathUtils.degToRad(angle);
    });

    if (motion.elapsed >= motion.duration) {
      motion.tracks.forEach((track) => {
        const initialRotation = this.initialRotations.get(track.linkName);
        track.link.rotation[track.axis] = initialRotation[track.axis] + THREE.MathUtils.degToRad(track.targetAngle);
      });
      this.activeMotion = null;
      motion.resolve();
    }
  }

  pause(seconds) {
    return new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
  }
}
