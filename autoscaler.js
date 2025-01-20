const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const pino = require('pino');
const pretty = require('pino-pretty')
const logger = pino(pretty({
    colorize: false,
}));


// Constants

//default limit if cpu upper limit is not set 
const CPU_PERCENTAGE_UPPER_LIMIT = 85;
//default limit if cpu lower limit is not set
const CPU_PERCENTAGE_LOWER_LIMIT = 25;
const PROMETHEUS_API = "api/v1/query?query=";
const PROMETHEUS_QUERY = "sum(rate(container_cpu_usage_seconds_total%7Bcontainer_label_com_docker_swarm_task_name%3D~%27.%2B%27%7D%5B5m%5D))BY(container_label_com_docker_swarm_service_name%2Cinstance)*100";

// Helper functions to get service lists
async function getHighCpuServices(prometheusResults) {
    return prometheusResults.data.result
        .filter(item => parseFloat(item.value[1]) > CPU_PERCENTAGE_UPPER_LIMIT)
        .map(item => item.metric.container_label_com_docker_swarm_service_name);
}

async function getAllServices(prometheusResults) {
    return [...new Set(prometheusResults.data.result
        .map(item => item.metric.container_label_com_docker_swarm_service_name))];
}

async function getLowCpuServices(prometheusResults) {
    return prometheusResults.data.result
        .filter(item => parseFloat(item.value[1]) < CPU_PERCENTAGE_LOWER_LIMIT)
        .map(item => item.metric.container_label_com_docker_swarm_service_name);
}

// Service inspection and scaling functions
async function getServiceInfo(serviceName) {
    const { stdout } = await execAsync(`docker service inspect ${serviceName}`);
    return JSON.parse(stdout)[0];
}

async function defaultScale(serviceName) {
    try {
        const serviceInfo = await getServiceInfo(serviceName);
        const autoScaleLabel = serviceInfo.Spec.Labels['swarm.autoscaler'];
        const replicaMinimum = parseInt(serviceInfo.Spec.Labels['swarm.autoscaler.minimum']);
        const replicaMaximum = parseInt(serviceInfo.Spec.Labels['swarm.autoscaler.maximum']);

        if (autoScaleLabel === 'true') {
            logger.info(`Service ${serviceName} has an autoscale label.`);
            const currentReplicas = serviceInfo.Spec.Mode.Replicated.Replicas;

            if (replicaMinimum > currentReplicas) {
                logger.info(`Service ${serviceName} is below the minimum. Scaling to the minimum of ${replicaMinimum}`);
                await execAsync(`docker service scale ${serviceName}=${replicaMinimum}`);
            } else if (currentReplicas > replicaMaximum) {
                logger.info(`Service ${serviceName} is above the maximum. Scaling to the maximum of ${replicaMaximum}`);
                await execAsync(`docker service scale ${serviceName}=${replicaMaximum}`);
            }
        } else {
            logger.warn(`Service ${serviceName} does not have an autoscale label.`);
        }
    } catch (error) {
        logger.error(`Error in defaultScale for ${serviceName}:`, error);
    }
}

async function scaleDown(serviceName) {
    try {
        const serviceInfo = await getServiceInfo(serviceName);
        const autoScaleLabel = serviceInfo.Spec.Labels['swarm.autoscaler'];
        const replicaMinimum = parseInt(serviceInfo.Spec.Labels['swarm.autoscaler.minimum']);

        if (autoScaleLabel === 'true') {
            const currentReplicas = serviceInfo.Spec.Mode.Replicated.Replicas;
            const newReplicas = currentReplicas - 1;

            if (replicaMinimum <= newReplicas) {
                logger.info(`Scaling down the service ${serviceName} to ${newReplicas}`);
                await execAsync(`docker service scale ${serviceName}=${newReplicas}`);
            } else if (currentReplicas === replicaMinimum) {
                logger.info(`Service ${serviceName} has the minimum number of replicas.`);
            }
        }
    } catch (error) {
        logger.error(`Error in scaleDown for ${serviceName}:`, error);
    }
}

async function scaleUp(serviceName) {
    try {
        const serviceInfo = await getServiceInfo(serviceName);
        const autoScaleLabel = serviceInfo.Spec.Labels['swarm.autoscaler'];
        const replicaMaximum = parseInt(serviceInfo.Spec.Labels['swarm.autoscaler.maximum']);

        if (autoScaleLabel === 'true') {
            const currentReplicas = serviceInfo.Spec.Mode.Replicated.Replicas;
            const newReplicas = currentReplicas + 2;

            if (currentReplicas === replicaMaximum) {
                logger.info(`Service ${serviceName} already has the maximum of ${replicaMaximum} replicas`);
            } else if (replicaMaximum >= newReplicas) {
                logger.info(`Scaling up the service ${serviceName} to ${newReplicas}`);
                await execAsync(`docker service scale ${serviceName}=${newReplicas}`);
            }
        }
    } catch (error) {
        logger.error(`Error in scaleUp for ${serviceName}:`, error);
    }
}

// Main function
async function main() {
    try {
        const prometheusUrl = process.env.PROMETHEUS_URL;
        const response = await axios.get(`${prometheusUrl}/${PROMETHEUS_API}${PROMETHEUS_QUERY}`);
        const prometheusResults = response.data;

        logger.info('Prometheus results');
        logger.debug(JSON.stringify(prometheusResults, null, 2));

        // Handle all services
        const allServices = await getAllServices(prometheusResults);
        for (const service of allServices) {
            await defaultScale(service);
        }

        // Handle high CPU services
        logger.info('Checking for high cpu services');
        const highCpuServices = await getHighCpuServices(prometheusResults);
        for (const service of highCpuServices) {
            const serviceInfo = await getServiceInfo(service);
            const cpuUpperLimit = parseInt(serviceInfo.Spec.Labels['swarm.cpu.upper_limit']); //or use defailt value
            //if cpu upper limit is not set, use default value
            if (!cpuUpperLimit) {
                cpuUpperLimit = CPU_PERCENTAGE_UPPER_LIMIT
            }
            logger.info(`Service ${service} is above ${cpuUpperLimit} percent cpu usage.`);
            await scaleUp(service);
        }

        // Handle low CPU services
        logger.info('Checking for low cpu services');
        const lowCpuServices = await getLowCpuServices(prometheusResults);
        for (const service of lowCpuServices) {
            const serviceInfo = await getServiceInfo(service);
            const cpuLowerLimit = parseInt(serviceInfo.Spec.Labels['swarm.cpu.lower_limit']); //or use defailt value

            //if cpu lower limit is not set, use default value
            if (!cpuLowerLimit) {
                cpuLowerLimit = CPU_PERCENTAGE_LOWER_LIMIT
            }

            logger.info(`Service ${service} is below ${cpuLowerLimit} percent cpu usage.`);
            await scaleDown(service);
        }
    } catch (error) {
        logger.error('Error in main:', error);
    }
}

// Main loop
async function run() {
    const interval = parseInt(process.env.INTERVAL || '60');
    const loop = process.env.LOOP !== 'no';

    do {
        await main();
        if (loop) {
            logger.info(`Waiting ${interval} seconds for the next test`);
            await new Promise(resolve => setTimeout(resolve, interval * 1000));
        }
    } while (loop);
}

// Start the application
run().catch(error => {
    logger.error('Error in run:', error);
});