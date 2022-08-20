import {ArcballCamera} from "arcball_camera";
import {Controller} from "ez_canvas_controller";
import {mat4, vec3} from "gl-matrix";

import shaderCode from "./shaders.wgsl";
import {
    colormaps,
    fetchVolume,
    fillSelector,
    getCubeMesh,
    getVolumeDimensions,
    linearToSRGB,
    sphericalDir,
    uploadImage,
    uploadVolume,
    volumes
} from "./volume.js";

(async () => {
    if (navigator.gpu === undefined) {
        document.getElementById("webgpu-canvas").setAttribute("style", "display:none;");
        document.getElementById("no-webgpu").setAttribute("style", "display:block;");
        return;
    }

    var adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        document.getElementById("webgpu-canvas").setAttribute("style", "display:none;");
        document.getElementById("no-webgpu").setAttribute("style", "display:block;");
        return;
    }
    var device = await adapter.requestDevice();

    // Get a context to display our rendered image on the canvas
    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("webgpu");

    // Setup shader modules
    var shaderModule = device.createShaderModule({code: shaderCode});
    var compilationInfo = await shaderModule.compilationInfo();
    if (compilationInfo.messages.length > 0) {
        var hadError = false;
        console.log("Shader compilation log:");
        for (var i = 0; i < compilationInfo.messages.length; ++i) {
            var msg = compilationInfo.messages[i];
            console.log(`${msg.lineNum}:${msg.linePos} - ${msg.message}`);
            hadError = hadError || msg.type == "error";
        }
        if (hadError) {
            console.log("Shader failed to compile");
            return;
        }
    }

    const defaultEye = vec3.set(vec3.create(), 0.5, 0.5, 2.5);
    const center = vec3.set(vec3.create(), 0.5, 0.5, 0.5);
    const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);

    const cube = getCubeMesh();

    // Upload cube to use to trigger raycasting of the volume
    var vertexBuffer = device.createBuffer({
        size: cube.vertices.length * 4,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(cube.vertices);
    vertexBuffer.unmap();

    var indexBuffer = device.createBuffer(
        {size: cube.indices.length * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true});
    new Uint16Array(indexBuffer.getMappedRange()).set(cube.indices);
    indexBuffer.unmap();

    // Create a buffer to store the view parameters
    var viewParamsSize = (16 + 4 * 3 + 3) * 4;
    var viewParamsBuffer = device.createBuffer(
        {size: viewParamsSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});

    var sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
    });

    var volumePicker = document.getElementById("volumeList");
    var colormapPicker = document.getElementById("colormapList");

    fillSelector(volumePicker, volumes);
    fillSelector(colormapPicker, colormaps);

    // Fetch and upload the volume
    var volumeName = "Bonsai";
    if (window.location.hash) {
        var linkedDataset = decodeURI(window.location.hash.substring(1));
        if (linkedDataset in volumes) {
            volumePicker.value = linkedDataset;
            volumeName = linkedDataset;
        } else {
            alert(`Linked to invalid data set ${linkedDataset}`);
            return;
        }
    }

    var volumeDims = getVolumeDimensions(volumes[volumeName]);
    const longestAxis = Math.max(volumeDims[0], Math.max(volumeDims[1], volumeDims[2]));
    var volumeScale = [
        volumeDims[0] / longestAxis,
        volumeDims[1] / longestAxis,
        volumeDims[2] / longestAxis
    ];

    var colormapName = "Cool Warm";
    var colormapTexture = await uploadImage(device, colormaps[colormapName]);

    var volumeTexture =
        await fetchVolume(volumes[volumeName])
            .then((volumeData) => { return uploadVolume(device, volumeDims, volumeData); });

    // We need to ping-pong the accumulation buffers because read-write storage textures are
    // missing and we can't have the same texture bound as both a read texture and storage
    // texture
    var accumBuffers = [
        device.createTexture({
            size: [canvas.width, canvas.height, 1],
            format: "rgba32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
        }),
        device.createTexture({
            size: [canvas.width, canvas.height, 1],
            format: "rgba32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
        })
    ];

    var accumBufferViews = [accumBuffers[0].createView(), accumBuffers[1].createView()];

    // Setup render outputs
    var swapChainFormat = "bgra8unorm";
    context.configure({
        device: device,
        format: swapChainFormat,
        usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
        alphaMode: "premultiplied"
    });

    var bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {type: "uniform"}
            },
            {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {viewDimension: "3d"}},
            {binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {viewDimension: "2d"}},
            {binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
            {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {sampleType: "unfilterable-float", viewDimension: "2d"}
            },
            {
                binding: 5,
                visibility: GPUShaderStage.FRAGMENT,
                storageTexture: {
                    // Would be great to have read-write back
                    access: "write-only",
                    format: "rgba32float"
                }
            },
        ]
    });

    // Create render pipeline
    var layout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});

    var vertexState = {
        module: shaderModule,
        entryPoint: "vertex_main",
        buffers: [{
            arrayStride: 3 * 4,
            attributes: [{format: "float32x3", offset: 0, shaderLocation: 0}]
        }]
    };

    var fragmentState = {
        module: shaderModule,
        entryPoint: "fragment_main",
        targets: [{
            format: swapChainFormat,
            blend: {
                color: {srcFactor: "one", dstFactor: "one-minus-src-alpha"},
                alpha: {srcFactor: "one", dstFactor: "one-minus-src-alpha"}
            }
        }]
    };

    var renderPipeline = device.createRenderPipeline({
        layout: layout,
        vertex: vertexState,
        fragment: fragmentState,
        primitive: {
            topology: "triangle-strip",
            stripIndexFormat: "uint16",
            cullMode: "front",
        }
    });

    var clearColor = linearToSRGB(0.1);
    var renderPassDesc = {
        colorAttachments: [{
            view: undefined,
            loadOp: "clear",
            storeOp: "store",
            clearValue: [clearColor, clearColor, clearColor, 1]
        }]
    };

    var camera = new ArcballCamera(defaultEye, center, up, 2, [canvas.width, canvas.height]);
    var proj = mat4.perspective(
        mat4.create(), 50 * Math.PI / 180.0, canvas.width / canvas.height, 0.1, 100);
    var projView = mat4.create();

    var frameId = 0;

    // Register mouse and touch listeners
    var controller = new Controller();
    controller.mousemove = function(prev, cur, evt) {
        if (evt.buttons == 1) {
            frameId = 0;
            camera.rotate(prev, cur);

        } else if (evt.buttons == 2) {
            frameId = 0;
            camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
        }
    };
    controller.wheel = function(amt) {
        frameId = 0;
        camera.zoom(amt);
    };
    controller.pinch = controller.wheel;
    controller.twoFingerDrag = function(drag) {
        frameId = 0;
        camera.pan(drag);
    };
    controller.registerForCanvas(canvas);

    // Reset accumulation when the light parameters change
    var lightPhiSlider = document.getElementById("phiRange");
    var lightThetaSlider = document.getElementById("thetaRange");
    var lightStrengthSlider = document.getElementById("lightStrength");
    lightPhiSlider.oninput = function() {
        frameId = 0;
    };
    lightThetaSlider.oninput = function() {
        frameId = 0;
    };
    lightStrengthSlider.oninput = function() {
        frameId = 0;
    };

    var animationFrame = function() {
        var resolve = null;
        var promise = new Promise(r => resolve = r);
        window.requestAnimationFrame(resolve);
        return promise
    };
    requestAnimationFrame(animationFrame);

    var bindGroupEntries = [
        {binding: 0, resource: {buffer: viewParamsBuffer}},
        {binding: 1, resource: volumeTexture.createView()},
        {binding: 2, resource: colormapTexture.createView()},
        {binding: 3, resource: sampler},
        // Updated each frame because we need to ping pong the accumulation buffers
        {binding: 4, resource: null},
        {binding: 5, resource: null}
    ];

    var upload = device.createBuffer({
        size: viewParamsSize,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: false
    });

    var sigmaTScale = 100.0;
    var sigmaSScale = 1.0;

    while (true) {
        await animationFrame();
        if (document.hidden) {
            continue;
        }

        // Fetch a new volume or colormap if a new one was selected
        if (volumeName != volumePicker.value) {
            volumeName = volumePicker.value;
            history.replaceState(history.state, "", "#" + volumeName);

            volumeDims = getVolumeDimensions(volumes[volumeName]);
            const longestAxis =
                Math.max(volumeDims[0], Math.max(volumeDims[1], volumeDims[2]));
            volumeScale = [
                volumeDims[0] / longestAxis,
                volumeDims[1] / longestAxis,
                volumeDims[2] / longestAxis
            ];

            volumeTexture = await fetchVolume(volumes[volumeName]).then((volumeData) => {
                return uploadVolume(device, volumeDims, volumeData);
            });

            // Reset accumulation and update the bindgroup
            frameId = 0;
            bindGroupEntries[1].resource = volumeTexture.createView();
        }

        if (colormapName != colormapPicker.value) {
            colormapName = colormapPicker.value;
            colormapTexture = await uploadImage(device, colormaps[colormapName]);

            // Reset accumulation and update the bindgroup
            frameId = 0;
            bindGroupEntries[2].resource = colormapTexture.createView();
        }

        // Update camera buffer
        projView = mat4.mul(projView, proj, camera.camera);

        var lightDir = sphericalDir(lightThetaSlider.value, lightPhiSlider.value);

        {
            await upload.mapAsync(GPUMapMode.WRITE);
            var eyePos = camera.eyePos();
            var map = upload.getMappedRange();
            var f32map = new Float32Array(map);
            var u32map = new Uint32Array(map);

            // TODO: A struct layout size computer/writer utility would help here
            f32map.set(projView, 0);
            f32map.set(eyePos, 16);
            f32map.set(volumeScale, 16 + 4);
            f32map.set(lightDir, 16 + 4 * 2);
            f32map.set([lightStrengthSlider.value], 16 + 4 * 2 + 3);
            u32map.set([frameId], 16 + 4 * 3);
            f32map.set([sigmaTScale, sigmaSScale], 16 + 4 * 3 + 1);

            upload.unmap();
        }

        bindGroupEntries[4].resource = accumBufferViews[frameId % 2];
        bindGroupEntries[5].resource = accumBufferViews[(frameId + 1) % 2];

        var bindGroup =
            device.createBindGroup({layout: bindGroupLayout, entries: bindGroupEntries});

        var commandEncoder = device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(upload, 0, viewParamsBuffer, 0, viewParamsSize);

        renderPassDesc.colorAttachments[0].view = context.getCurrentTexture().createView();
        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.setVertexBuffer(0, vertexBuffer);
        renderPass.setIndexBuffer(indexBuffer, "uint16");
        renderPass.draw(cube.vertices.length / 3, 1, 0, 0);

        renderPass.end();
        device.queue.submit([commandEncoder.finish()]);

        // Explicitly release the GPU buffer instead of waiting for GC
        frameId += 1;
    }
})();
